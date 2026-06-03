import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { generateInvoice, generatePDFUPO } from '../dist/ksef-fe-invoice-converter.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES ?? 10 * 1024 * 1024);

installFileReaderPolyfill();

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && request.url === '/invoice/pdf') {
      const { xml, additionalData } = await readInvoicePayload(request);
      const pdf = await generateInvoice(createXmlFile(xml), additionalData, 'base64');

      sendPdf(response, Buffer.from(pdf, 'base64'), 'invoice.pdf');
      return;
    }

    if (request.method === 'POST' && request.url === '/upo/pdf') {
      const xml = await readRequestText(request);
      const pdf = await generatePDFUPO(createXmlFile(xml));

      sendPdf(response, Buffer.from(await pdf.arrayBuffer()), 'upo.pdf');
      return;
    }

    sendJson(response, 404, {
      error: 'Not found',
      routes: ['GET /health', 'POST /invoice/pdf', 'POST /upo/pdf'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    sendJson(response, 500, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`PDF server listening on http://${host}:${port}`);
});

function createXmlFile(xml) {
  return new File([xml], 'document.xml', { type: 'application/xml' });
}

async function readInvoicePayload(request) {
  const contentType = getHeader(request, 'content-type') ?? '';
  const body = await readRequestBody(request);

  if (contentType.includes('multipart/form-data')) {
    const fields = parseMultipartFormData(body, contentType);

    return {
      xml: getRequiredField(fields, ['xml', 'invoiceXml', 'invoice', 'file']),
      additionalData: getAdditionalData(fields),
    };
  }

  if (contentType.includes('application/json')) {
    const payload = JSON.parse(body.toString('utf8'));

    return {
      xml: getRequiredField(payload, ['xml', 'invoiceXml', 'invoice']),
      additionalData: getAdditionalData(payload),
    };
  }

  return {
    xml: body.toString('utf8'),
    additionalData: getAdditionalData({}),
  };
}

function getAdditionalData(fields) {
  return {
    nrKSeF: getOptionalField(fields, ['nrKSeF', 'ksefNumber', 'ksef_number']) ?? '',
    qrCode: getOptionalField(fields, ['qrCode', 'qr_code']),
    qr2Code: getOptionalField(fields, ['qr2Code', 'qr2_code']),
    watermark: getOptionalField(fields, ['watermark']),
  };
}

function getHeader(request, name) {
  const value = request.headers[name];

  return Array.isArray(value) ? value[0] : value;
}

function readRequestText(request) {
  return readRequestBody(request).then((body) => body.toString('utf8'));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    request.on('data', (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > maxBodyBytes) {
        reject(new Error(`Request body is too large. Limit is ${maxBodyBytes} bytes.`));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseMultipartFormData(body, contentType) {
  const boundary = contentType.match(/boundary="?([^";]+)"?/)?.[1];

  if (!boundary) {
    throw new Error('Missing multipart boundary.');
  }

  const fields = {};
  const parts = body.toString('utf8').split(`--${boundary}`);

  for (const part of parts) {
    if (!part || part === '--\r\n' || part === '--') {
      continue;
    }

    const [rawHeaders, ...rawValueParts] = part.split('\r\n\r\n');
    const value = rawValueParts.join('\r\n\r\n').replace(/\r\n--$/, '').replace(/\r\n$/, '');
    const name = rawHeaders.match(/name="([^"]+)"/)?.[1];

    if (name) {
      fields[name] = value;
    }
  }

  return fields;
}

function getRequiredField(fields, names) {
  const value = getOptionalField(fields, names);

  if (!value) {
    throw new Error(`Missing required field. Expected one of: ${names.join(', ')}.`);
  }

  return value;
}

function getOptionalField(fields, names) {
  for (const name of names) {
    const value = fields?.[name];

    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function sendPdf(response, pdf, fileName) {
  response.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${fileName}"`,
    'Content-Length': pdf.length,
  });
  response.end(pdf);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function installFileReaderPolyfill() {
  if (globalThis.FileReader) {
    return;
  }

  globalThis.FileReader = class FileReader {
    result = null;
    onload = null;
    onerror = null;

    async readAsText(file) {
      try {
        this.result = await file.text();
        this.onload?.({ target: this });
      } catch (error) {
        this.onerror?.({ target: this, error });
      }
    }
  };
}
