// Reads the legally required Impressum of a German company site: who represents the company
// (Geschäftsführer, Inhaber), the legal form and the register number. Used only to find the right person
// on LinkedIn and to address the company correctly; never for e-mail outreach.

export interface ImpressumPerson {
  name: string;
  role: string;
}
export interface Impressum {
  people: ImpressumPerson[];
  legalForm: string | null;
  register: string | null; // "HRB 12345"
  court: string | null; // "Amtsgericht München"
}

const ROLE =
  /(Geschäftsführende[rn]?\s+Gesellschafter(?:in)?|Geschäftsführer(?:in)?|Geschäftsführung|Geschäftsleitung|Inhaber(?:in)?|Vertretungsberechtigte[rn]?(?:\s+(?:Geschäftsführer(?:in)?|Person(?:en)?|Gesellschafter(?:in)?))?|Vertreten\s+durch|Managing\s+Directors?|Vorstand|CEO)\b\s*(?:\([^)]*\))?\s*(?:ist|sind)?\s*[:\-–]?\s*/gi;
const PARTICLE = '(?:von|van|de|der|den|zu|zur|vom|del|di)';
const WORD = "[A-ZÄÖÜ][a-zäöüßéèáóú']+(?:-[A-ZÄÖÜ][a-zäöüßéèáóú']+)?";
const NAME = new RegExp(
  `(?:(?:Dr\\.|Prof\\.|Dipl\\.-?\\s?\\w+\\.?|Herrn?|Frau|B\\.\\s?Sc\\.|M\\.\\s?Sc\\.|MBA)\\s+)*(${WORD}(?:\\s+${WORD})?(?:\\s+${PARTICLE})*\\s+${WORD})`,
  'g',
);
const NOT_A_NAME =
  /\b(GmbH|Gesellschaft|Verwaltungs|Beteiligungs|Holding|Group|Shop|Handel[s]?|Service|Telefon|Telefax|Sitz|Amtsgericht|Registergericht|Handelsregister|Umsatzsteuer|Steuernummer|Straße|Strasse|Weg|Platz|Allee|Deutschland|Germany|Kontakt|Mail|Verantwortlich|Inhaltlich|Datenschutz|Aufsichtsrat|Vorsitzende[rn]?|Geschäftsführ\w*|Inhaber\w*|Vertret\w*|Haftungsbeschränkt|Online|Media|Marketing|Solutions|Consulting|Deutsche|Berlin|München|Hamburg|Köln)\b/i;

export function htmlToLines(html: string): string[] {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/td|\/dd|\/dt)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(
      /&(auml|ouml|uuml|Auml|Ouml|Uuml|szlig);/g,
      (_, e: string) =>
        ({ auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' })[e]!,
    )
    .split('\n')
    .map((l) => l.replace(/[ \t\xa0]+/g, ' ').trim())
    .filter(Boolean);
}

function namesIn(text: string): string[] {
  const found: string[] = [];
  // names end at the next label ("Telefon:", "Sitz:") or sentence
  const part = text.split(
    /\b(?:Telefon|Tel\.|Fax|E-?Mail|Sitz|Registergericht|Amtsgericht|Handelsregister|USt|Umsatzsteuer|Steuer|Anschrift|Adresse)\b/i,
  )[0]!;
  for (const m of part.matchAll(NAME)) {
    const name = m[1]!.replace(/\s+/g, ' ').trim();
    if (NOT_A_NAME.test(name) || name.length > 45) continue;
    if (!found.includes(name)) found.push(name);
  }
  return found.slice(0, 4);
}

export function parseImpressum(html: string): Impressum {
  const lines = htmlToLines(html);
  const text = lines.join('\n');
  const people: ImpressumPerson[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    ROLE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROLE.exec(line))) {
      const role = m[1]!.replace(/\s+/g, ' ');
      let rest = line.slice(m.index + m[0].length);
      // the name may stand on the next line(s)
      if (!namesIn(rest).length) rest = [lines[i + 1], lines[i + 2]].filter(Boolean).join(' , ');
      for (const name of namesIn(rest))
        if (!people.some((p) => p.name === name)) people.push({ name, role });
    }
  }
  const legal = text.match(
    /\b(GmbH\s*&\s*Co\.\s*KG|gGmbH|GmbH|UG\s*\(haftungsbeschränkt\)|UG|e\.\s?K(?:fm|fr)?\.|OHG|KG|GbR|AG|SE)(?![\wäöü])/,
  );
  const reg = text.match(/\b(HR\s?[AB])\s*(?:Nr\.?\s*)?(\d[\d ]{1,8}\d)\b/);
  const court = text.match(
    /\b(Amtsgericht|Registergericht)\s*:?\s*((?:Amtsgericht\s+)?[A-ZÄÖÜ][\wäöüß.-]+(?:\s(?:am|an der|im|i\.)\s?[A-ZÄÖÜ][\wäöüß.-]+)?(?:\s\([\wäöüß ]+\))?)/,
  );
  return {
    people: people.slice(0, 4),
    legalForm: legal ? legal[1]!.replace(/\s+/g, ' ') : null,
    register: reg ? `${reg[1]!.replace(/\s/g, '')} ${reg[2]!.replace(/\s/g, '')}` : null,
    court: court ? `Amtsgericht ${court[2]!.replace(/^Amtsgericht\s+/, '')}` : null,
  };
}
