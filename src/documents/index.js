// src/documents/index.js
// Generación de documentos como ARCHIVO (Fase 3A): el jefe pide "hazme una propuesta /
// resumen / carta…", el modelo redacta el contenido y aquí lo renderizamos a un archivo
// (txt/md sin deps, PDF vía pdfkit, .docx vía docx) que se envía por WhatsApp como adjunto.
// El render devuelve un Buffer en memoria (Baileys envía Buffers directo) → sin temporales.

import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';

export const DOC_FORMATS = ['pdf', 'txt', 'md', 'docx'];

const MIME = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Nombre de archivo seguro a partir del título: sin acentos ni caracteres raros, con guiones.
export function safeFileName(title, ext) {
  const base =
    String(title || 'documento')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // quitar diacríticos
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'documento';
  return `${base}.${ext}`;
}

// Divide el contenido en párrafos por línea(s) en blanco; conserva los saltos simples como espacio.
function paragraphsOf(content) {
  return String(content)
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function renderTxt(title, content) {
  const head = title ? `${title}\n${'='.repeat(Math.min(title.length, 60))}\n\n` : '';
  return Buffer.from(head + String(content).trim() + '\n', 'utf8');
}

export function renderPdf(title, content) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 56 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      if (title) doc.font('Helvetica-Bold').fontSize(18).text(title).moveDown(0.8);
      doc.font('Helvetica').fontSize(11);
      for (const para of paragraphsOf(content)) {
        doc.text(para, { align: 'left', lineGap: 2 }).moveDown(0.6);
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

export async function renderDocx(title, content) {
  const children = [];
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
  for (const para of paragraphsOf(content)) {
    children.push(new Paragraph({ children: [new TextRun(para)], spacing: { after: 160 } }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// Construye el documento → { buffer, fileName, mimetype }. Lanza si no hay contenido.
export async function buildDocument({ title, content, format = 'pdf' } = {}) {
  const fmt = DOC_FORMATS.includes(format) ? format : 'pdf';
  const text = String(content ?? '').trim();
  if (!text) throw new Error('El documento no tiene contenido.');
  let buffer;
  if (fmt === 'txt' || fmt === 'md') buffer = renderTxt(title, text);
  else if (fmt === 'docx') buffer = await renderDocx(title, text);
  else buffer = await renderPdf(title, text);
  return { buffer, fileName: safeFileName(title, fmt), mimetype: MIME[fmt] };
}
