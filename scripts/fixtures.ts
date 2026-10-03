/**
 * Twelve synthetic home health referrals. Every name, ID, address and number
 * here is made up (phone numbers use the 555-01xx fiction range). These drive
 * both the PDFs in data/referrals and the answer key the evals score against.
 */
import { npiValid } from '../src/lib/rules';

export type Layout = 'discharge' | 'order' | 'letter';
export type Signature = 'drawn' | 'esign' | 'blank';
export type Service =
  | 'skilled_nursing'
  | 'physical_therapy'
  | 'occupational_therapy'
  | 'speech_therapy'
  | 'home_health_aide'
  | 'medical_social_work';
export type PayerType = 'medicare' | 'medicare_advantage' | 'medicaid' | 'commercial' | 'self_pay';

export interface SyntheticCase {
  id: string;
  layout: Layout;
  tests: string;
  seed: boolean;
  seedOwner: string | null;
  seedHoursAgo: number;
  seedConfidence: Record<string, number>;
  seedStartOfCareInDays: number | null;
  source: { name: string; address: string; phone: string; fax: string };
  faxSent: string;
  patient: { name: string; dob: string; dobText?: string; phone: string | null; phoneText?: string; address: string };
  payer: { name: string; type: PayerType; memberId: string | null; memberIdText?: string };
  referralDate: string;
  physician: { name: string; npi: string };
  diagnoses: { text: string; code: string }[];
  notes: string;
  homebound: boolean | null;
  homeboundText?: string;
  f2f: string | null;
  f2fText?: string;
  services: Service[];
  frequencies?: Partial<Record<Service, string>>;
  signature: Signature;
  signatureDate: string | null;
}

/** Appends the check digit that makes a 9-digit base a valid NPI. */
function npi(base: string): string {
  for (let d = 0; d <= 9; d++) if (npiValid(base + d)) return base + d;
  throw new Error(`no check digit for ${base}`);
}

/** Changes the last digit. Luhn catches every single-digit change, so this NPI always fails. */
function typo(validNpi: string): string {
  return validNpi.slice(0, 9) + ((Number(validNpi[9]) + 3) % 10);
}

const DOCS = {
  raman: { name: 'Anita Raman, MD', npi: npi('173048296') },
  wexler: { name: 'Paul Wexler, DO', npi: npi('158392047') },
  oyelaran: { name: 'Grace Oyelaran, MD', npi: npi('120457783') },
  kirchner: { name: 'Thomas Kirchner, MD', npi: npi('196204518') },
  morrow: { name: 'Leah Morrow, NP', npi: npi('134879012') },
  salinas: { name: 'Victor Salinas, MD', npi: npi('182736450') },
  castellanos: { name: 'Miriam Castellanos, MD', npi: npi('167305928') },
};

const base = { seedOwner: null, seedHoursAgo: 24, seedConfidence: {}, seedStartOfCareInDays: null } as const;

export const CASES: SyntheticCase[] = [
  {
    ...base,
    id: '01',
    layout: 'discharge',
    tests: 'Clean Medicare discharge referral. Should land in Ready.',
    seed: true,
    seedOwner: 'priya',
    seedHoursAgo: 52,
    source: { name: 'Westbrook General Hospital', address: '1200 Westbrook Ave, Yonkers, NY 10701', phone: '(914) 555-0100', fax: '(914) 555-0101' },
    faxSent: '09/29/2026 14:22',
    patient: { name: 'Dolores Whitfield', dob: '1941-03-14', phone: '(914) 555-0142', address: '41 Linden Ave, Apt 3B, Yonkers, NY 10701' },
    payer: { name: 'Medicare', type: 'medicare', memberId: '4TQ7-HM2-RK58' },
    referralDate: '2026-09-29',
    physician: DOCS.raman,
    diagnoses: [
      { text: 'Hypertensive heart disease with heart failure', code: 'I11.0' },
      { text: 'Chronic diastolic (congestive) heart failure', code: 'I50.32' },
    ],
    notes:
      'Admitted 9/24 for a CHF exacerbation, discharged 9/28. Needs daily weights, teaching on her new furosemide dose and a low-sodium diet. Lives alone; her daughter checks in most evenings.',
    homebound: true,
    homeboundText: 'Leaves home only for medical visits, with a walker and help, because of shortness of breath on exertion.',
    f2f: '2026-09-27',
    services: ['skilled_nursing', 'physical_therapy'],
    signature: 'drawn',
    signatureDate: '2026-09-29',
  },
  {
    ...base,
    id: '02',
    layout: 'order',
    tests: 'Medicare order with a blank signature line. Should be flagged as an unsigned order.',
    seed: true,
    seedOwner: 'priya',
    seedHoursAgo: 30,
    source: { name: 'Coney Point Primary Care', address: '2900 Ocean Pkwy, Brooklyn, NY 11235', phone: '(718) 555-0110', fax: '(718) 555-0111' },
    faxSent: '09/30/2026 10:05',
    patient: { name: 'Harold Benning', dob: '1938-11-02', phone: '(718) 555-0177', address: '2290 Ocean Pkwy, Apt 5D, Brooklyn, NY 11223' },
    payer: { name: 'Medicare', type: 'medicare', memberId: '7CJ2-AF4-WN61' },
    referralDate: '2026-09-30',
    physician: DOCS.wexler,
    diagnoses: [
      { text: 'Type 2 diabetes mellitus with hyperglycemia', code: 'E11.65' },
      { text: 'Long term (current) use of insulin', code: 'Z79.4' },
    ],
    notes:
      'New insulin start. Needs teaching on glucose checks and insulin injections. Low vision makes self-injection hard; his wife helps.',
    homebound: true,
    homeboundText: 'Cannot leave home without his wife helping him, because of low vision and an unsteady gait.',
    f2f: '2026-09-26',
    services: ['skilled_nursing'],
    frequencies: { skilled_nursing: '3w1, 2w2, 1w2' },
    signature: 'blank',
    signatureDate: null,
  },
  {
    ...base,
    id: '03',
    layout: 'letter',
    tests: 'Clean Medicaid letter. Seeded with a low-confidence address so it waits for a person to check it.',
    seed: true,
    seedHoursAgo: 5,
    seedConfidence: { address: 0.62 },
    source: { name: 'Mott Haven Community Health Center', address: '480 E 143rd St, Bronx, NY 10454', phone: '(718) 555-0120', fax: '(718) 555-0121' },
    faxSent: '10/02/2026 16:40',
    patient: { name: 'Rosa Delgado-Marsh', dob: '1956-07-21', phone: '(347) 555-0119', address: '88 Cypress Ave, Apt 2, Bronx, NY 10454' },
    payer: { name: 'New York State Medicaid', type: 'medicaid', memberId: 'KX48213T' },
    referralDate: '2026-10-02',
    physician: DOCS.oyelaran,
    diagnoses: [
      { text: 'Pressure ulcer of sacral region, stage 3', code: 'L89.153' },
      { text: 'Type 2 diabetes mellitus without complications', code: 'E11.9' },
    ],
    notes:
      'Stage 3 sacral pressure injury. Needs wound care three times a week with wet-to-dry dressings, and an aide for bathing. Uses a wheelchair and lives with her husband.',
    homebound: true,
    homeboundText: 'She is homebound and uses a wheelchair at all times.',
    f2f: '2026-09-30',
    services: ['skilled_nursing', 'home_health_aide'],
    signature: 'esign',
    signatureDate: '2026-10-02',
  },
  {
    ...base,
    id: '04',
    layout: 'discharge',
    tests: 'Medicare Advantage discharge with no member ID. Should be flagged as missing it.',
    seed: true,
    seedOwner: 'priya',
    seedHoursAgo: 50,
    source: { name: 'St. Aldric Hospital', address: '35 Hospital Rd, Hempstead, NY 11550', phone: '(516) 555-0130', fax: '(516) 555-0131' },
    faxSent: '09/29/2026 08:51',
    patient: { name: 'Walter Okafor', dob: '1939-07-22', phone: '(516) 555-0163', address: '17 Birch Hollow Rd, Hempstead, NY 11550' },
    payer: { name: 'Aetna Medicare Advantage', type: 'medicare_advantage', memberId: null, memberIdText: 'Card not provided. Family to send a copy.' },
    referralDate: '2026-09-28',
    physician: DOCS.kirchner,
    diagnoses: [
      { text: 'Aftercare following joint replacement surgery', code: 'Z47.1' },
      { text: 'Presence of right artificial knee joint', code: 'Z96.651' },
    ],
    notes:
      'Right total knee replacement on 9/24. PT for gait training and range of motion, OT for daily living tasks. Uses a walker at all times; high fall risk.',
    homebound: true,
    homeboundText: 'Needs a walker and another person to leave home safely after knee surgery.',
    f2f: '2026-09-24',
    services: ['physical_therapy', 'occupational_therapy'],
    signature: 'drawn',
    signatureDate: '2026-09-28',
  },
  {
    ...base,
    id: '05',
    layout: 'order',
    tests: 'Clean commercial order. Seeded as already scheduled.',
    seed: true,
    seedOwner: 'priya',
    seedHoursAgo: 120,
    seedStartOfCareInDays: 2,
    source: { name: 'Yorkville Internal Medicine', address: '1520 York Ave, New York, NY 10028', phone: '(212) 555-0140', fax: '(212) 555-0141' },
    faxSent: '09/24/2026 15:10',
    patient: { name: 'Agnes Petrakis', dob: '1962-01-09', phone: '(212) 555-0188', address: '305 E 86th St, Apt 12F, New York, NY 10028' },
    payer: { name: 'UnitedHealthcare Choice Plus', type: 'commercial', memberId: '902551774' },
    referralDate: '2026-09-24',
    physician: DOCS.morrow,
    diagnoses: [{ text: 'Chronic obstructive pulmonary disease with (acute) exacerbation', code: 'J44.1' }],
    notes:
      'Recent COPD flare with new home oxygen at 2 L. Skilled nursing for respiratory checks and inhaler technique; PT to build endurance.',
    homebound: true,
    homeboundText: 'Short of breath after a few steps and cannot leave home without help.',
    f2f: '2026-09-23',
    services: ['skilled_nursing', 'physical_therapy'],
    frequencies: { skilled_nursing: '2w2, 1w3', physical_therapy: '2w4' },
    signature: 'drawn',
    signatureDate: '2026-09-24',
  },
  {
    ...base,
    id: '06',
    layout: 'letter',
    tests: 'Medicare letter, unsigned, with the face-to-face note still to follow. Two blockers.',
    seed: true,
    seedHoursAgo: 26,
    source: { name: 'Great South Bay Neurology', address: '250 Medford Ave, Patchogue, NY 11772', phone: '(631) 555-0150', fax: '(631) 555-0151' },
    faxSent: '10/01/2026 11:30',
    patient: { name: 'Leonard Kowalczyk', dob: '1944-05-30', phone: '(631) 555-0124', address: '9 Harbor View Ln, Patchogue, NY 11772' },
    payer: { name: 'Medicare', type: 'medicare', memberId: '2DN5-YG7-XP03' },
    referralDate: '2026-10-01',
    physician: DOCS.salinas,
    diagnoses: [
      { text: 'Hemiplegia and hemiparesis following cerebral infarction affecting right dominant side', code: 'I69.351' },
    ],
    notes:
      'Ischemic stroke in August with right-sided weakness and mild expressive aphasia. Needs PT, OT and speech therapy evaluations. Lives with his son.',
    homebound: true,
    homeboundText: 'He is homebound because of right-sided weakness and needs help with every transfer.',
    f2f: null,
    f2fText: 'The face-to-face encounter note will follow under separate cover.',
    services: ['physical_therapy', 'occupational_therapy', 'speech_therapy'],
    signature: 'blank',
    signatureDate: null,
  },
  {
    ...base,
    id: '07',
    layout: 'discharge',
    tests: 'The NPI has a typo, so it fails the check digit. Should be flagged.',
    seed: true,
    seedOwner: 'priya',
    seedHoursAgo: 96,
    source: { name: 'Westchester Valley Hospital', address: '19 Bryant Ave, White Plains, NY 10605', phone: '(914) 555-0160', fax: '(914) 555-0161' },
    faxSent: '09/27/2026 13:02',
    patient: { name: 'Beatrice Hollins', dob: '1947-09-18', phone: '(914) 555-0156', address: '62 Maple Terrace, White Plains, NY 10603' },
    payer: { name: 'Humana Gold Plus (HMO)', type: 'medicare_advantage', memberId: 'H51862043' },
    referralDate: '2026-09-27',
    physician: { name: DOCS.raman.name, npi: typo(DOCS.raman.npi) },
    diagnoses: [{ text: 'Pneumonia, unspecified organism', code: 'J18.9' }],
    notes:
      'Hospitalized 9/20 to 9/26 for pneumonia. Skilled nursing for vital signs, oxygen saturation and finishing oral antibiotics; PT for deconditioning.',
    homebound: true,
    homeboundText: 'Too weak to leave home without help since the hospital stay.',
    f2f: '2026-09-26',
    services: ['skilled_nursing', 'physical_therapy'],
    signature: 'drawn',
    signatureDate: '2026-09-27',
  },
  {
    ...base,
    id: '08',
    layout: 'order',
    tests: 'An ICD-10 code faxed as NI8.4 (letter I for the digit 1). Should be flagged, not silently fixed.',
    seed: true,
    seedHoursAgo: 74,
    source: { name: 'Newburgh Renal Associates', address: '600 Broadway, Newburgh, NY 12550', phone: '(845) 555-0170', fax: '(845) 555-0171' },
    faxSent: '09/30/2026 17:45',
    patient: { name: 'Samuel Achterberg', dob: '1951-12-03', phone: '(845) 555-0131', address: '4 Orchard St, Newburgh, NY 12550' },
    payer: { name: 'Empire BlueCross BlueShield PPO', type: 'commercial', memberId: 'YLW884126503' },
    referralDate: '2026-09-30',
    physician: DOCS.castellanos,
    diagnoses: [
      { text: 'Hypertensive chronic kidney disease', code: 'I12.9' },
      { text: 'Chronic kidney disease, stage 4', code: 'NI8.4' },
    ],
    notes:
      'CKD stage 4 with a 1.5 L fluid restriction and a new renal diet. Skilled nursing for blood pressure checks, lab coordination and medication teaching.',
    homebound: true,
    homeboundText: 'Fatigue from kidney disease keeps him at home except for dialysis planning visits.',
    f2f: '2026-09-29',
    services: ['skilled_nursing'],
    frequencies: { skilled_nursing: '1w4' },
    signature: 'drawn',
    signatureDate: '2026-09-30',
  },
  {
    ...base,
    id: '09',
    layout: 'letter',
    tests: 'Commercial letter with no signature. Unsigned, but not Medicare, so a Medicare view should leave it out.',
    seed: true,
    seedOwner: 'priya',
    seedHoursAgo: 9,
    source: { name: 'Palisades Spine & Pain', address: '130 Main St, Fort Lee, NJ 07024', phone: '(201) 555-0180', fax: '(201) 555-0181' },
    faxSent: '10/02/2026 09:20',
    patient: { name: 'Iris Fennimore', dob: '1958-04-11', phone: '(201) 555-0109', address: '22 Lemoine Ave, Apt 7A, Fort Lee, NJ 07024' },
    payer: { name: 'Cigna Open Access Plus', type: 'commercial', memberId: 'U4820177301' },
    referralDate: '2026-10-02',
    physician: DOCS.wexler,
    diagnoses: [
      { text: 'Muscle weakness (generalized)', code: 'M62.81' },
      { text: 'Unsteadiness on feet', code: 'R26.81' },
      { text: 'History of falling', code: 'Z91.81' },
    ],
    notes: 'Two falls in the past month. Needs PT for balance and strength and a home safety evaluation. Walks with a cane.',
    homebound: null,
    f2f: null,
    services: ['physical_therapy'],
    signature: 'blank',
    signatureDate: null,
  },
  {
    ...base,
    id: '10',
    layout: 'discharge',
    tests: 'Live demo upload. Clean Medicare discharge that should come out Ready.',
    seed: false,
    source: { name: 'Elmhurst Bay Medical Center', address: '79-01 Broadway, Elmhurst, NY 11373', phone: '(718) 555-0190', fax: '(718) 555-0191' },
    faxSent: '10/02/2026 12:15',
    patient: { name: 'Curtis Vandermeer', dob: '1940-02-27', phone: '(718) 555-0193', address: '75-12 35th Ave, Apt 4C, Jackson Heights, NY 11372' },
    payer: { name: 'Medicare', type: 'medicare', memberId: '9HV3-PC1-TE47' },
    referralDate: '2026-10-02',
    physician: DOCS.salinas,
    diagnoses: [
      { text: "Parkinson's disease without dyskinesia, without mention of fluctuations", code: 'G20.A1' },
      { text: 'Unsteadiness on feet', code: 'R26.81' },
    ],
    notes:
      'Worsening gait with a fall at home last week, no injury. PT for gait and fall prevention; OT for daily living tasks and home safety. Lives with his wife.',
    homebound: true,
    homeboundText: 'Leaves home only with his wife and a walker, for medical visits.',
    f2f: '2026-09-30',
    services: ['physical_therapy', 'occupational_therapy'],
    signature: 'drawn',
    signatureDate: '2026-10-02',
  },
  {
    ...base,
    id: '11',
    layout: 'order',
    tests: 'Live demo upload. Medicare order with a blank signature line, the one to flag on camera.',
    seed: false,
    source: { name: 'Sound Shore Senior Care', address: '16 Guion Pl, New Rochelle, NY 10801', phone: '(914) 555-0196', fax: '(914) 555-0197' },
    faxSent: '10/02/2026 15:48',
    patient: { name: 'Evelyn Takahashi-Brook', dob: '1936-08-05', phone: '(914) 555-0171', address: '12 Ridgeway Ct, New Rochelle, NY 10804' },
    payer: { name: 'Medicare', type: 'medicare', memberId: '5MR8-JD6-UA92' },
    referralDate: '2026-10-02',
    physician: DOCS.morrow,
    diagnoses: [{ text: 'Chronic obstructive pulmonary disease, unspecified', code: 'J44.9' }],
    notes:
      'New nebulizer and oxygen at night. Skilled nursing for respiratory status and medication teaching; an aide for bathing twice a week.',
    homebound: true,
    homeboundText: 'Becomes short of breath walking across the room and does not leave home without help.',
    f2f: '2026-09-29',
    services: ['skilled_nursing', 'home_health_aide'],
    frequencies: { skilled_nursing: '2w3', home_health_aide: '2w6' },
    signature: 'blank',
    signatureDate: null,
  },
  {
    ...base,
    id: '12',
    layout: 'letter',
    tests: "Live demo upload. Informal letter: two-digit birth year and a phone number that is the daughter's.",
    seed: false,
    source: { name: 'Concourse Family Medicine', address: '1650 Selwyn Ave, Bronx, NY 10457', phone: '(718) 555-0198', fax: '(718) 555-0199' },
    faxSent: '10/01/2026 18:02',
    patient: {
      name: 'Raymond Lusk',
      dob: '1947-06-01',
      dobText: '6/1/47',
      phone: '(347) 555-0136',
      phoneText: "347.555.0136, which is his daughter Carla's cell. He has no phone of his own",
      address: '2104 Grand Concourse, Apt 6D, Bronx, NY 10457',
    },
    payer: { name: 'Fidelis Care Medicaid Managed Care', type: 'medicaid', memberId: 'FC7731025' },
    referralDate: '2026-10-01',
    physician: DOCS.castellanos,
    diagnoses: [
      { text: 'Muscle weakness (generalized)', code: 'M62.81' },
      { text: 'Other abnormalities of gait and mobility', code: 'R26.89' },
    ],
    notes:
      'Home from a 10-day hospital stay for sepsis and very deconditioned. Needs PT, and skilled nursing for medication management (12 medications). Lives with his daughter Carla.',
    homebound: true,
    homeboundText: 'He does not leave the apartment without two people helping him.',
    f2f: '2026-09-30',
    f2fText: 'I saw him in the office for a face-to-face visit on 9/30/2026.',
    services: ['physical_therapy', 'skilled_nursing'],
    signature: 'esign',
    signatureDate: '2026-10-01',
  },
];

/** The answer key for one case: what a careful person would type in from this document. */
export function truthFor(c: SyntheticCase): Record<string, unknown> {
  return {
    patient_name: c.patient.name,
    date_of_birth: c.patient.dob,
    phone: c.patient.phone,
    address: c.patient.address,
    payer_name: c.payer.name,
    payer_type: c.payer.type,
    member_id: c.payer.memberId,
    referral_date: c.referralDate,
    referral_source: c.source.name,
    referring_physician: c.physician.name,
    physician_npi: c.physician.npi,
    primary_diagnosis: c.diagnoses[0].text,
    icd10_codes: c.diagnoses.map((d) => d.code),
    clinical_notes: c.notes,
    homebound: c.homebound,
    face_to_face_date: c.f2f,
    services_ordered: c.services,
    order_signed: c.signature !== 'blank',
    signature_date: c.signatureDate,
  };
}
