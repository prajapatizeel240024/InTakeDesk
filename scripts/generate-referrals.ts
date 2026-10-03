/**
 * Builds the synthetic referral PDFs in data/referrals and data/answer-key.json
 * from scripts/fixtures.ts, in three layouts: a hospital discharge form, a
 * two-page physician order and a free-text letter.
 *
 * The output is deterministic, so running this again gives byte-identical
 * files. The duplicate-upload check relies on file hashes, so that matters.
 *
 *   npm run referrals:generate
 */
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { configPath, parseConfig } from '../src/lib/config';
import { mbiValid, npiValid } from '../src/lib/rules';
import type { FieldValue } from '../src/lib/types';
import { computeFlags } from '../src/lib/workflow';
import { CASES, truthFor, type Service, type SyntheticCase } from './fixtures';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'data', 'referrals');
const FIXED_DATE = new Date('2026-10-02T12:00:00Z');
const ANSWER_KEY_TODAY = '2026-10-03';

const INK = rgb(0.1, 0.1, 0.12);
const GRAY = rgb(0.4, 0.4, 0.43);
const RULE = rgb(0.5, 0.5, 0.53);
const SHADE = rgb(0.88, 0.88, 0.88);
const PEN = rgb(0.08, 0.14, 0.46);

const PAGE: [number, number] = [612, 792];
const LEFT = 54;
const RIGHT = 558;
const WIDTH = RIGHT - LEFT;
const TOP = 742;

const SERVICE_LABEL: Record<Service, string> = {
  skilled_nursing: 'Skilled nursing',
  physical_therapy: 'Physical therapy',
  occupational_therapy: 'Occupational therapy',
  speech_therapy: 'Speech therapy',
  home_health_aide: 'Home health aide',
  medical_social_work: 'Medical social work',
};
const SERVICE_ABBR: Record<Service, string> = {
  skilled_nursing: 'SN',
  physical_therapy: 'PT',
  occupational_therapy: 'OT',
  speech_therapy: 'ST',
  home_health_aide: 'HHA',
  medical_social_work: 'MSW',
};
const ALL_SERVICES = Object.keys(SERVICE_LABEL) as Service[];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const longDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const shortDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1].slice(0, 3)} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

function wordsList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

interface Fonts {
  sans: PDFFont;
  sansBold: PDFFont;
  sansOblique: PDFFont;
  serif: PDFFont;
  serifBold: PDFFont;
  mono: PDFFont;
}

/** A page plus a cursor that moves down as things are drawn. */
class Sheet {
  y = TOP;
  constructor(
    readonly doc: PDFDocument,
    public page: PDFPage,
    readonly f: Fonts,
  ) {}

  newPage() {
    this.page = this.doc.addPage(PAGE);
    this.y = TOP;
  }

  text(s: string, x: number, y: number, size = 10, font = this.f.sans, color: RGB = INK) {
    this.page.drawText(s, { x, y, size, font, color });
  }

  right(s: string, xRight: number, y: number, size = 10, font = this.f.sans, color: RGB = INK) {
    this.text(s, xRight - font.widthOfTextAtSize(s, size), y, size, font, color);
  }

  center(s: string, y: number, size = 10, font = this.f.sans, color: RGB = INK) {
    this.text(s, (PAGE[0] - font.widthOfTextAtSize(s, size)) / 2, y, size, font, color);
  }

  wrap(s: string, width: number, size: number, font: PDFFont): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of s.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, size) > width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  para(s: string, opts: { x?: number; width?: number; size?: number; font?: PDFFont; leading?: number; after?: number } = {}) {
    const { x = LEFT, width = WIDTH, size = 10, font = this.f.sans } = opts;
    const leading = opts.leading ?? size * 1.4;
    for (const line of this.wrap(s, width, size, font)) {
      this.text(line, x, this.y, size, font);
      this.y -= leading;
    }
    this.y -= opts.after ?? 0;
  }

  rule(y: number, x1 = LEFT, x2 = RIGHT, thickness = 0.6, color: RGB = RULE) {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  checkbox(x: number, y: number, checked: boolean, label: string, size = 9.5) {
    this.page.drawRectangle({ x, y: y - 1, width: 9, height: 9, borderColor: INK, borderWidth: 0.8 });
    if (checked) {
      this.page.drawLine({ start: { x: x + 1.5, y: y + 0.5 }, end: { x: x + 7.5, y: y + 6.5 }, thickness: 1.2, color: INK });
      this.page.drawLine({ start: { x: x + 1.5, y: y + 6.5 }, end: { x: x + 7.5, y: y + 0.5 }, thickness: 1.2, color: INK });
    }
    this.text(label, x + 14, y, size);
  }
}

/** A labelled field on a form: small label, value on an underline. */
function formRow(sheet: Sheet, cells: { label: string; value: string; width: number; small?: boolean }[]) {
  let x = LEFT;
  for (const cell of cells) {
    sheet.text(cell.label, x, sheet.y, 7.5, sheet.f.sansBold, GRAY);
    if (cell.small) sheet.text(cell.value, x, sheet.y - 13, 8.5, sheet.f.sansOblique);
    else sheet.text(cell.value, x, sheet.y - 13, 10.5);
    sheet.rule(sheet.y - 16, x, x + cell.width - 12, 0.5);
    x += cell.width;
  }
  sheet.y -= 31;
}

function sectionBar(sheet: Sheet, title: string) {
  sheet.page.drawRectangle({ x: LEFT, y: sheet.y - 4, width: WIDTH, height: 14, color: SHADE });
  sheet.text(title, LEFT + 5, sheet.y, 8.5, sheet.f.sansBold);
  sheet.y -= 24;
}

function signatureBlock(sheet: Sheet, c: SyntheticCase, label: string, dateLabel: string) {
  const lineY = sheet.y - 20;
  sheet.text(label, LEFT, lineY + 3, 8.5, sheet.f.sansBold, GRAY);
  const x = LEFT + sheet.f.sansBold.widthOfTextAtSize(label, 8.5) + 8;
  sheet.rule(lineY, x, x + 230, 0.7, INK);
  if (c.signature === 'drawn') {
    sheet.page.drawSvgPath(
      'M0 0 C 6 -18, 13 9, 19 -3 S 30 -16, 38 -5 S 50 9, 58 -7 S 72 -12, 80 -3 S 96 3, 110 -9 S 128 -4, 140 -6',
      { x: x + 18, y: lineY + 12, borderColor: PEN, borderWidth: 1.3 },
    );
  }
  if (c.signature === 'esign' && c.signatureDate) {
    sheet.text(`Electronically signed by ${c.physician.name} on ${mdy(c.signatureDate)} at 4:31 PM`, x, lineY - 11, 8, sheet.f.sansOblique, GRAY);
  }
  const dateX = x + 252;
  sheet.text(dateLabel, dateX, lineY + 3, 8.5, sheet.f.sansBold, GRAY);
  const dx = dateX + sheet.f.sansBold.widthOfTextAtSize(dateLabel, 8.5) + 6;
  sheet.rule(lineY, dx, RIGHT, 0.7, INK);
  if (c.signature !== 'blank' && c.signatureDate) sheet.text(mdy(c.signatureDate), dx + 4, lineY + 3, 10.5);
  sheet.y = lineY - 26;
}

function dischargeLayout(sheet: Sheet, c: SyntheticCase) {
  const { f } = sheet;
  sheet.text(c.source.name, LEFT, 736, 13.5, f.sansBold);
  sheet.text(`${c.source.address}    Tel ${c.source.phone}    Fax ${c.source.fax}`, LEFT, 722, 8, f.sans, GRAY);
  sheet.right('HOME HEALTH REFERRAL', RIGHT, 736, 12, f.sansBold);
  sheet.right('Discharge Planning', RIGHT, 722, 8.5, f.sans, GRAY);
  sheet.rule(712, LEFT, RIGHT, 1.2, INK);
  sheet.right(`Referral date: ${mdy(c.referralDate)}`, RIGHT, 698, 9);
  sheet.y = 680;

  sectionBar(sheet, 'PATIENT');
  formRow(sheet, [
    { label: 'Name', value: c.patient.name, width: 300 },
    { label: 'Date of birth', value: c.patient.dobText ?? mdy(c.patient.dob), width: 204 },
  ]);
  formRow(sheet, [
    { label: 'Home address', value: c.patient.address, width: 360 },
    { label: 'Phone', value: c.patient.phoneText ?? c.patient.phone ?? '', width: 144 },
  ]);

  sectionBar(sheet, 'INSURANCE');
  formRow(sheet, [
    { label: 'Primary payer', value: c.payer.name, width: 260 },
    c.payer.memberId
      ? { label: 'Member ID', value: c.payer.memberId, width: 244 }
      : { label: 'Member ID', value: c.payer.memberIdText ?? '', width: 244, small: true },
  ]);

  sectionBar(sheet, 'DIAGNOSES');
  sheet.text('ICD-10', LEFT, sheet.y, 7.5, f.sansBold, GRAY);
  sheet.text('Description', LEFT + 80, sheet.y, 7.5, f.sansBold, GRAY);
  sheet.y -= 14;
  for (const d of c.diagnoses) {
    sheet.text(d.code, LEFT, sheet.y, 10.5);
    sheet.text(d.text, LEFT + 80, sheet.y, 10);
    sheet.y -= 15;
  }
  sheet.y -= 8;

  sectionBar(sheet, 'CLINICAL SUMMARY');
  sheet.para(c.notes, { size: 10, after: 6 });
  sheet.text('Homebound:', LEFT, sheet.y, 9, f.sansBold);
  sheet.checkbox(LEFT + 64, sheet.y, c.homebound === true, 'Yes');
  sheet.checkbox(LEFT + 110, sheet.y, c.homebound === false, 'No');
  sheet.y -= 15;
  if (c.homeboundText) sheet.para(c.homeboundText, { size: 9.5, after: 4 });
  sheet.text('Face-to-face encounter date:', LEFT, sheet.y, 9, f.sansBold);
  sheet.text(c.f2f ? mdy(c.f2f) : (c.f2fText ?? ''), LEFT + 136, sheet.y, 10);
  sheet.y -= 26;

  sectionBar(sheet, 'SERVICES ORDERED');
  ALL_SERVICES.forEach((s, i) => {
    sheet.checkbox(LEFT + (i % 3) * 170, sheet.y - Math.floor(i / 3) * 18, c.services.includes(s), SERVICE_LABEL[s]);
  });
  sheet.y -= 46;

  sectionBar(sheet, 'ORDERING PHYSICIAN');
  formRow(sheet, [
    { label: 'Physician', value: c.physician.name, width: 300 },
    { label: 'NPI', value: c.physician.npi, width: 204 },
  ]);
  signatureBlock(sheet, c, 'Signature', 'Date');
}

function orderLayout(sheet: Sheet, c: SyntheticCase) {
  const { f } = sheet;
  sheet.center(c.source.name, 736, 16, f.serifBold);
  sheet.center(c.source.address, 721, 9.5, f.serif, GRAY);
  sheet.center(`Phone ${c.source.phone}    Fax ${c.source.fax}`, 709, 9.5, f.serif, GRAY);
  sheet.rule(700, LEFT, RIGHT, 0.8, INK);
  sheet.center('PHYSICIAN ORDERS FOR HOME HEALTH CARE', 680, 12, f.sansBold);
  sheet.right(`Order date: ${shortDate(c.referralDate)}`, RIGHT, 662, 9.5);

  // Demographics as a bordered grid.
  const rows: [string, string, string, string][] = [
    ['Patient name', c.patient.name, 'Date of birth', c.patient.dobText ?? shortDate(c.patient.dob)],
    ['Address', c.patient.address, 'Phone', c.patient.phone ? c.patient.phone.replace(/[()]/g, '').replace(' ', '-') : ''],
    ['Insurance', c.payer.name, 'Policy / member no.', c.payer.memberId ?? (c.payer.memberIdText ?? '')],
  ];
  let y = 648;
  const split = LEFT + 330;
  for (const [l1, v1, l2, v2] of rows) {
    sheet.page.drawRectangle({ x: LEFT, y: y - 30, width: WIDTH, height: 30, borderColor: INK, borderWidth: 0.6 });
    sheet.page.drawLine({ start: { x: split, y }, end: { x: split, y: y - 30 }, thickness: 0.6, color: INK });
    sheet.text(l1, LEFT + 5, y - 10, 7.5, f.sansBold, GRAY);
    sheet.text(v1, LEFT + 5, y - 23, 10);
    sheet.text(l2, split + 5, y - 10, 7.5, f.sansBold, GRAY);
    sheet.text(v2, split + 5, y - 23, 10);
    y -= 30;
  }
  sheet.y = y - 24;

  sheet.text('Diagnoses', LEFT, sheet.y, 10.5, f.sansBold);
  sheet.y -= 16;
  c.diagnoses.forEach((d, i) => {
    sheet.text(`${i === 0 ? 'Primary' : 'Secondary'}: ${d.text} (ICD-10 ${d.code})`, LEFT + 10, sheet.y, 10);
    sheet.y -= 15;
  });
  sheet.y -= 10;
  sheet.text('Reason for home health care', LEFT, sheet.y, 10.5, f.sansBold);
  sheet.y -= 16;
  sheet.para(c.notes, { x: LEFT + 10, width: WIDTH - 10, size: 10 });
  sheet.right('Continued on page 2', RIGHT, 60, 8.5, f.sansOblique, GRAY);

  sheet.newPage();
  sheet.text(`Patient: ${c.patient.name}    DOB: ${c.patient.dobText ?? shortDate(c.patient.dob)}`, LEFT, 736, 9, f.sans, GRAY);
  sheet.rule(728, LEFT, RIGHT, 0.6);
  sheet.y = 708;
  sheet.text('Orders', LEFT, sheet.y, 10.5, f.sansBold);
  sheet.y -= 17;
  for (const s of c.services) {
    const freq = c.frequencies?.[s];
    sheet.text(`${SERVICE_LABEL[s]} (${SERVICE_ABBR[s]}): ${freq ? `frequency ${freq}` : 'evaluate and treat'}`, LEFT + 10, sheet.y, 10);
    sheet.y -= 15;
  }
  sheet.para('Teach the patient and caregiver. Report changes in condition to the ordering practitioner.', { x: LEFT + 10, size: 9.5, after: 12 });

  sheet.text('Homebound status', LEFT, sheet.y, 10.5, f.sansBold);
  sheet.y -= 16;
  if (c.homebound) sheet.para(`I certify that this patient is confined to the home. ${c.homeboundText ?? ''}`, { x: LEFT + 10, width: WIDTH - 10, after: 10 });
  else sheet.para('Not stated.', { x: LEFT + 10, after: 10 });

  sheet.text('Face-to-face encounter', LEFT, sheet.y, 10.5, f.sansBold);
  sheet.y -= 16;
  sheet.para(
    c.f2f
      ? `A face-to-face encounter related to the primary reason for home health care took place on ${shortDate(c.f2f)}.`
      : (c.f2fText ?? ''),
    { x: LEFT + 10, width: WIDTH - 10, after: 18 },
  );

  sheet.text('Certifying practitioner', LEFT, sheet.y, 10.5, f.sansBold);
  sheet.y -= 18;
  sheet.text(`Name: ${c.physician.name}`, LEFT + 10, sheet.y, 10);
  sheet.text(`NPI: ${c.physician.npi}`, LEFT + 290, sheet.y, 10);
  sheet.y -= 10;
  signatureBlock(sheet, c, 'Signature', 'Date signed');
}

function letterLayout(sheet: Sheet, c: SyntheticCase) {
  const { f } = sheet;
  const body = { size: 11, font: f.serif, leading: 15.5, after: 9 };
  sheet.text(c.source.name, LEFT, 736, 15, f.serifBold);
  sheet.text(c.source.address, LEFT, 721, 9.5, f.serif, GRAY);
  sheet.text(`Phone ${c.source.phone}    Fax ${c.source.fax}`, LEFT, 709, 9.5, f.serif, GRAY);
  sheet.rule(699, LEFT, RIGHT, 0.6);
  sheet.y = 676;
  sheet.para(longDate(c.referralDate), { ...body, after: 6 });
  sheet.para('Sunrise Home Health', { ...body, after: 0 });
  sheet.para('Attn: Intake', { ...body });
  const dob = c.patient.dobText ?? longDate(c.patient.dob);
  sheet.para(`Re: Home health referral for ${c.patient.name} (DOB ${dob})`, { ...body, font: f.serifBold });
  sheet.para('Dear Intake Team,', body);

  const phone = c.patient.phoneText ?? (c.patient.phone ? c.patient.phone.replace(/[()]/g, '').replace(' ', '.').replace('-', '.') : null);
  sheet.para(
    `I am referring ${c.patient.name}, born ${dob}, for home health care. ${c.patient.name} lives at ${c.patient.address}${phone ? ` and can be reached at ${phone}` : ''}.`,
    body,
  );
  sheet.para(
    c.payer.memberId
      ? `Insurance is ${c.payer.name}, member ID ${c.payer.memberId}.`
      : `Insurance is ${c.payer.name}. The member ID will follow.`,
    body,
  );
  sheet.para(`Diagnoses: ${c.diagnoses.map((d) => `${d.text} (${d.code})`).join('; ')}.`, body);
  sheet.para(c.notes, body);
  sheet.para(`Please provide ${wordsList(c.services.map((s) => SERVICE_LABEL[s].toLowerCase()))}.`, body);
  if (c.homebound !== null) sheet.para(c.homeboundText ?? (c.homebound ? 'The patient is homebound.' : 'The patient is not homebound.'), body);
  if (c.f2fText) sheet.para(c.f2fText, body);
  else if (c.f2f) sheet.para(`A face-to-face visit took place on ${longDate(c.f2f)}.`, body);
  sheet.para('Thank you for your help with this patient’s care.', body);
  sheet.para('Sincerely,', { ...body, after: 0 });

  const sigY = sheet.y - 14;
  if (c.signature === 'drawn') {
    sheet.page.drawSvgPath('M0 0 C 6 -18, 13 9, 19 -3 S 30 -16, 38 -5 S 50 9, 58 -7 S 72 -12, 80 -3 S 96 3, 110 -9', {
      x: LEFT + 4,
      y: sigY + 8,
      borderColor: PEN,
      borderWidth: 1.3,
    });
  } else if (c.signature === 'esign' && c.signatureDate) {
    sheet.text(`/s/ ${c.physician.name}, electronically signed ${mdy(c.signatureDate)}`, LEFT, sigY, 9.5, f.sansOblique, GRAY);
  } else {
    sheet.rule(sigY - 4, LEFT, LEFT + 200, 0.7, INK);
  }
  sheet.y = sigY - 20;
  sheet.para(c.physician.name, { ...body, after: 0 });
  sheet.para(`NPI ${c.physician.npi}`, { ...body, after: 0 });
}

function speckle(page: PDFPage, rand: () => number, count: number) {
  for (let i = 0; i < count; i++) {
    const size = 0.4 + rand() * 1.2;
    page.drawRectangle({
      x: 30 + rand() * 552,
      y: 30 + rand() * 720,
      width: size,
      height: size * (0.6 + rand()),
      color: rgb(0.3, 0.3, 0.3),
      opacity: 0.45 + rand() * 0.4,
    });
  }
}

/** Fax banner and footer on every page, added last so the page count is known. */
function faxChrome(doc: PDFDocument, c: SyntheticCase, f: Fonts) {
  let seed = Number(c.id) * 7919;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    let banner = `${c.faxSent}  FROM: ${c.source.fax} ${c.source.name.toUpperCase()}  TO: SUNRISE HOME HEALTH INTAKE  P.${i + 1}/${pages.length}`;
    while (f.mono.widthOfTextAtSize(banner, 7.5) > 540) banner = banner.replace(/ \S+ (?=TO:)/, ' ');
    page.drawText(banner, { x: 36, y: 772, size: 7.5, font: f.mono, color: GRAY });
    page.drawLine({ start: { x: 36, y: 767 }, end: { x: 576, y: 767 }, thickness: 0.4, color: GRAY });
    page.drawText('Synthetic test document made for Intake Desk. Not a real patient.', { x: 36, y: 22, size: 6.5, font: f.sans, color: GRAY });
    speckle(page, rand, 70);
  });
}

async function render(c: SyntheticCase): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Home health referral ${c.id} (synthetic)`);
  doc.setCreator('Intake Desk synthetic data generator');
  doc.setProducer('Intake Desk synthetic data generator');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const f: Fonts = {
    sans: await doc.embedFont(StandardFonts.Helvetica),
    sansBold: await doc.embedFont(StandardFonts.HelveticaBold),
    sansOblique: await doc.embedFont(StandardFonts.HelveticaOblique),
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const sheet = new Sheet(doc, doc.addPage(PAGE), f);
  if (c.layout === 'discharge') dischargeLayout(sheet, c);
  else if (c.layout === 'order') orderLayout(sheet, c);
  else letterLayout(sheet, c);
  if (sheet.y < 40) throw new Error(`referral ${c.id} ran off the bottom of the page`);
  faxChrome(doc, c, f);
  return doc.save();
}

/** Catches fixture mistakes: the only bad IDs and codes should be the ones a case is meant to test. */
function checkFixture(c: SyntheticCase) {
  if (c.id !== '07' && !npiValid(c.physician.npi)) throw new Error(`case ${c.id}: NPI should be valid`);
  if (c.id === '07' && npiValid(c.physician.npi)) throw new Error('case 07: NPI should fail the check digit');
  if (c.payer.type === 'medicare' && c.payer.memberId && !mbiValid(c.payer.memberId)) throw new Error(`case ${c.id}: bad MBI`);
}

async function main() {
  const config = parseConfig(fs.readFileSync(configPath(ROOT), 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const referrals = [];
  for (const c of CASES) {
    checkFixture(c);
    const file = `referral-${c.id}.pdf`;
    fs.writeFileSync(path.join(OUT_DIR, file), await render(c));

    const fields = truthFor(c);
    const missing = config.fields.map((f) => f.key).filter((k) => !(k in fields));
    if (missing.length) throw new Error(`case ${c.id} has no answer for: ${missing.join(', ')}`);
    const data: Record<string, FieldValue> = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, confidence: 1, evidence: null, source: 'human', verified: true }]),
    );
    const expectedFlags = computeFlags(config, data, { today: ANSWER_KEY_TODAY }).map((flag) => flag.key);
    referrals.push({
      id: c.id,
      file,
      layout: c.layout,
      tests: c.tests,
      seed: c.seed,
      seedOwner: c.seedOwner,
      seedHoursAgo: c.seedHoursAgo,
      seedConfidence: c.seedConfidence,
      seedStartOfCareInDays: c.seedStartOfCareInDays,
      fields,
      expectedFlags,
    });
    console.log(`${file}  ${c.layout.padEnd(9)}  flags: ${expectedFlags.join(', ') || 'none'}`);
  }
  const key = { note: 'Synthetic data. Every person, ID and number here is made up.', referrals };
  fs.writeFileSync(path.join(ROOT, 'data', 'answer-key.json'), `${JSON.stringify(key, null, 2)}\n`);
  console.log(`Wrote ${referrals.length} PDFs to data/referrals and data/answer-key.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
