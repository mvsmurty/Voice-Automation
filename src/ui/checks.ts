// Deterministic stage checks computed from a run's transcript (agent lines only).
// The agent transcript is Gemini's transcription of the call audio, so wording varies; patterns are lenient.

export type StageStatus = 'pass' | 'fail' | 'na';
export interface StageCheck {
  id: string;
  label: string;
  status: StageStatus;
  detail?: string;
}
export interface ChecksResult {
  applicable: boolean;
  passed: number;
  total: number;
  stages: StageCheck[];
}

interface Line {
  who: string;
  text: string;
}

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|märz|mai|juni|juli|oktober|dezember|janvier|février|mars|avril|juin|juillet|août|septembre|octobre|novembre|décembre|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|dicembre|ledna|února|března|dubna|května|června|července|srpna|září|října|listopadu|prosince|januára|februára|marca|apríla|mája|júna|júla|augusta|septembra|októbra|novembra|decembra|januar|februar|mars|april|mai|juni|juli|august|oktober|desember';
const WEEKDAYS =
  'monday|tuesday|wednesday|thursday|friday|saturday|montag|dienstag|mittwoch|donnerstag|freitag|samstag|lundi|mardi|mercredi|jeudi|vendredi|samedi|lunedì|martedì|mercoledì|giovedì|venerdì|sabato|pondělí|úterý|středa|čtvrtek|pátek|sobota|pondelok|utorok|streda|štvrtok|piatok|sobota|mandag|tirsdag|onsdag|torsdag|fredag|lørdag';
const RE_DATE = new RegExp(`\\b(${MONTHS}|${WEEKDAYS}|tomorrow|morgen|demain|domani|zítra|zajtra|i morgen)\\b|\\b\\d{1,2}\\.\\s?\\d{1,2}\\.(\\s?\\d{2,4})?|\\b\\d{1,2}(st|nd|rd|th)\\b`, 'i');
const RE_TIME = /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(a\.?m\.?|p\.?m\.?|uhr|h)\b|o'clock/i;
const RE_QUESTION = /\?|\b(correct|richtig|stimmt|korrekt|d'accord|exact|giusto|správně|správne|riktig)\b/i;
const RE_ELSE =
  /anything else|something else|else i can|can i help you with anything|noch (etwas|was)|sonst noch|weiteres|weitere frage|autre chose|altro|něco dalšího|ještě něco|niečo ďalšie|ešte niečo|noe annet|annet jeg kan/i;
const RE_ORDER_WORDS =
  /(order|booking|reference|confirmation)\s+(number|reference|no\.?)|buchungsnummer|auftragsnummer|bestellnummer|referenznummer|numéro de (commande|réservation)|numero (d'ordine|di prenotazione)|číslo (objednávky|rezervace)|číslo (objednávky|rezervácie)|ordrenummer|bestillingsnummer/i;

const PHONE_CTX = /mobile|phone|handy|telefon|rufnummer|reach you|erreichen|callback|call back|rückruf|téléphone|numéro de téléphone|telefono|telefon|telefonní|mobil/i;
const joinDigits = (t: string) => t.replace(/(?<=\d)[\s,.-](?=\d)/g, '');
/** A line that announces the booking/order number (not a phone number). */
const orderNumberOf = (t: string): string | undefined => {
  if (PHONE_CTX.test(t)) return undefined;
  // Digit runs written as phone numbers (+49…) are never order numbers.
  return joinDigits(t).replace(/\+\s?\d+/g, ' ').match(/\b\d{7,}\b/)?.[0];
};

const PLATE_WORDS = /\b(district|letters?|digits?|numbers?|license|licence|plate|bezirk|buchstaben|ziffern|zahlen|kennzeichen|nummernschild|and|und|is|ist)\b/gi;
const normPlate = (s: string) =>
  s
    .replace(PLATE_WORDS, ' ')
    .toUpperCase()
    .replace(/Ä/g, 'A')
    .replace(/Ö/g, 'O')
    .replace(/Ü/g, 'U')
    .replace(/[^A-Z0-9]/g, '');

export function computeChecks(report: any): ChecksResult {
  const scenario = report?.scenario ?? {};
  const lines: Line[] = Array.isArray(report?.transcript) ? report.transcript : [];
  const agent = lines.filter((l) => l.who === 'agent').map((l) => l.text);
  const applicable = (scenario.endRequires?.length ?? 0) > 0 || /book/i.test(String(scenario.id ?? ''));
  if (!applicable) return { applicable: false, passed: 0, total: 0, stages: [] };

  const stages: StageCheck[] = [];
  const add = (id: string, label: string, status: StageStatus, detail?: string) => stages.push({ id, label, status, detail });

  const dateOffer = (t: string) => RE_DATE.test(t) && /appointment|termin|available|verfügbar|frei|disponible|rendez|dispon|termín|ledig|tilgjengelig|earliest|nächste|next/i.test(t);
  const firstDateIdx = agent.findIndex(dateOffer);
  const orderIdx = agent.findIndex((t) => orderNumberOf(t) !== undefined);
  const exp = normPlate(String(scenario.facts?.licence_plate ?? '').trim());
  const digits = exp.replace(/[A-Z]/g, '');

  // 1. Plate read-back: the last read-back before dates are offered must equal the expected plate exactly.
  if (!exp) add('plate', 'Plate read back correctly', 'na', 'No licence_plate fact in the scenario');
  else {
    const scope = agent.slice(0, firstDateIdx === -1 ? (orderIdx === -1 ? agent.length : orderIdx) : firstDateIdx);
    const reads = scope.filter((t) => digits && normPlate(t).includes(digits.slice(0, 3)) && RE_QUESTION.test(t));
    if (!reads.length) add('plate', 'Plate read back correctly', 'fail', 'Agent never read the plate back');
    else {
      const last = reads[reads.length - 1];
      const ok = normPlate(last).includes(exp);
      const wrong = reads.filter((t) => !normPlate(t).includes(exp)).length;
      add('plate', 'Plate read back correctly', ok ? 'pass' : 'fail', `${ok ? 'Final' : 'Last'} read-back: "${last.slice(0, 110)}"${wrong ? ` (${wrong} wrong read-back${wrong > 1 ? 's' : ''})` : ''}`);
    }
  }

  // 2. Date offered   3. Time offered
  const dateLine = agent.find(dateOffer);
  add('dates', 'Date offered', dateLine ? 'pass' : 'fail', dateLine?.slice(0, 120));
  const timeLine = agent.find((t) => RE_TIME.test(t) && (RE_DATE.test(t) || /appointment|termin|available|verfügbar|time|uhrzeit|zeit|slot/i.test(t)) && !PHONE_CTX.test(t));
  add('times', 'Time offered', timeLine ? 'pass' : 'fail', timeLine?.slice(0, 120));

  // 4. Final summary: a confirm question carrying date, time and plate, before the booking number.
  const upto = orderIdx === -1 ? agent.length : orderIdx;
  const summary = agent
    .slice(0, upto)
    .reverse()
    .find((t) => RE_QUESTION.test(t) && RE_DATE.test(t) && RE_TIME.test(t) && (exp ? normPlate(t).includes(digits.slice(0, 3)) : true));
  add('summary', 'Final summary read back', summary ? 'pass' : 'fail', summary?.slice(0, 140));

  // 5. Booking / order number announced (a 7+ digit number outside phone-number context)
  const num = orderIdx === -1 ? undefined : orderNumberOf(agent[orderIdx]);
  add('order', 'Booking number announced', num ? 'pass' : 'fail', num ? `Number: ${num}` : 'No booking or order number heard');

  // 6. "Anything else?" asked after the booking
  const elseIdx = agent.findIndex((t, i) => RE_ELSE.test(t) && (orderIdx === -1 || i >= orderIdx));
  add('else', 'Asked "anything else?"', elseIdx !== -1 ? 'pass' : 'fail', elseIdx !== -1 ? agent[elseIdx].slice(0, 100) : undefined);

  const total = stages.filter((s) => s.status !== 'na').length;
  const passed = stages.filter((s) => s.status === 'pass').length;
  return { applicable: true, passed, total, stages };
}
