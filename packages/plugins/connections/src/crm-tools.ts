import { z } from 'zod';
import { asArray, asRecord, cardOf, clip, enc, limit, Q, str, untrusted, type PersonToolDef } from './person-kit.ts';
import { htmlOf, idStr, noteText, numericId, salesforceId, searchWords, soqlString, textCard } from './support-kit.ts';

// The tools of a person's HubSpot and Salesforce connection (PLAN P16-07): look a customer up, read a contact or a case, and, each behind an approval card with exactly the
// text that will be saved, add a note and change the lead status of a contact (HubSpot) or the status of a case (Salesforce). Written the way support-tools.ts is. Nothing
// here deletes or merges a record, and an id in a path is checked against the form that provider's ids have and encoded.

// ---- HubSpot ------------------------------------------------------------------------------------------------------------------------------------------

const HS_PROPERTIES = ['firstname', 'lastname', 'email', 'company', 'jobtitle', 'lifecyclestage', 'hs_lead_status', 'lastmodifieddate'];
/** HubSpot's standard lead statuses. A portal can add its own; those are changed in HubSpot. */
export const HS_LEAD_STATUSES = ['NEW', 'OPEN', 'IN_PROGRESS', 'OPEN_DEAL', 'UNQUALIFIED', 'ATTEMPTED_TO_CONTACT', 'CONNECTED', 'BAD_TIMING'] as const;
/** The id HubSpot gives the association of a note with a contact. */
const NOTE_TO_CONTACT = 202;

const hsContact = (c: unknown): Record<string, unknown> => {
  const r = asRecord(c);
  const p = asRecord(r['properties']);
  const name = [str(p['firstname'], 100), str(p['lastname'], 100)].filter((x): x is string => x !== null && x !== '').join(' ');
  return {
    id: idStr(r['id']),
    name: name === '' ? null : name,
    email: str(p['email'], 320),
    company: str(p['company'], 200),
    jobTitle: str(p['jobtitle'], 200),
    lifecycleStage: str(p['lifecyclestage'], 40),
    leadStatus: str(p['hs_lead_status'], 40),
    modified: str(p['lastmodifieddate'], 40),
  };
};

const HUBSPOT_TOOLS: PersonToolDef[] = [
  {
    name: 'hubspot.find_contact',
    provider: 'hubspot',
    service: 'contacts',
    kind: 'read',
    description: `Find HubSpot contacts by words: a name, an email address or a company.${untrusted}`,
    input: z.strictObject({ query: searchWords, limit }),
    async run(api, input) {
      const { query: q, limit: n } = Q(input);
      const doc = asRecord(await api.json('/crm/v3/objects/contacts/search', { method: 'POST', body: { query: q, limit: n, properties: HS_PROPERTIES } }));
      return { ok: true, contacts: asArray(doc['results']).slice(0, n).map(hsContact) };
    },
  },
  {
    name: 'hubspot.read_contact',
    provider: 'hubspot',
    service: 'contacts',
    kind: 'read',
    description: `Read one HubSpot contact by the id a search answered.${untrusted}`,
    input: z.strictObject({ contactId: numericId('contact') }),
    async run(api, input) {
      const doc = await api.json(`/crm/v3/objects/contacts/${enc(String(input['contactId']))}`, { query: { properties: HS_PROPERTIES.join(',') } });
      return { ok: true, contact: hsContact(doc) };
    },
  },
  {
    name: 'hubspot.add_note',
    provider: 'hubspot',
    service: 'contacts_write',
    kind: 'write',
    description: "Add a note to a HubSpot contact's timeline, as the asking person. Needs the person's approval.",
    input: z.strictObject({ contactId: numericId('contact'), body: noteText('The text of the note.') }),
    card: (i) => textCard(`Add a note to HubSpot contact ${String(i['contactId'])}`, String(i['body']), { contact: String(i['contactId']), visibility: 'A note on the contact’s timeline, visible to your HubSpot users' }),
    async run(api, input) {
      const i = input as { contactId: string; body: string };
      const doc = asRecord(
        await api.json('/crm/v3/objects/notes', {
          method: 'POST',
          body: {
            properties: { hs_timestamp: api.now().toISOString(), hs_note_body: htmlOf(i.body) },
            associations: [{ to: { id: i.contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }],
          },
        }),
      );
      return { ok: true, contactId: i.contactId, noteId: idStr(doc['id']) };
    },
  },
  {
    name: 'hubspot.set_lead_status',
    provider: 'hubspot',
    service: 'contacts_write',
    kind: 'write',
    description: "Change the lead status of a HubSpot contact to one of HubSpot's standard values. Needs the person's approval.",
    input: z.strictObject({ contactId: numericId('contact'), status: z.enum(HS_LEAD_STATUSES) }),
    card: (i) => cardOf(`Set the lead status of HubSpot contact ${String(i['contactId'])} to ${String(i['status'])}`, { contact: String(i['contactId']), leadStatus: String(i['status']) }),
    async run(api, input) {
      const i = input as { contactId: string; status: string };
      await api.json(`/crm/v3/objects/contacts/${enc(i.contactId)}`, { method: 'PATCH', body: { properties: { hs_lead_status: i.status } } });
      return { ok: true, contactId: i.contactId, leadStatus: i.status };
    },
  },
];

// ---- Salesforce ---------------------------------------------------------------------------------------------------------------------------------------

/** A status as Salesforce spells a Case status: words and spaces. The org decides which are valid; Salesforce refuses the others. */
const caseStatus = z.string().regex(/^[A-Za-z][A-Za-z ]{0,39}$/, 'a status such as Working or Closed');

const sfCase = (c: unknown): Record<string, unknown> => {
  const r = asRecord(c);
  return {
    id: idStr(r['Id']),
    number: str(r['CaseNumber'], 30),
    subject: str(r['Subject'], 300),
    status: str(r['Status'], 40),
    priority: str(r['Priority'], 20),
    contactId: idStr(r['ContactId']),
    modified: str(r['LastModifiedDate'], 40),
  };
};

const query = async (api: { json(path: string, init?: { query?: Record<string, string | number> }): Promise<unknown> }, soql: string): Promise<unknown[]> =>
  asArray(asRecord(await api.json('/query', { query: { q: soql } }))['records']);

const SALESFORCE_TOOLS: PersonToolDef[] = [
  {
    name: 'salesforce.find_customer',
    provider: 'salesforce',
    service: 'records',
    kind: 'read',
    description: `Look up Salesforce contacts and accounts by words: a name or an email address.${untrusted}`,
    input: z.strictObject({ query: searchWords, limit }),
    async run(api, input) {
      const { query: q, limit: n } = Q(input);
      const like = soqlString(q, true).slice(1, -1);
      const contacts = await query(api, `SELECT Id, Name, Email, Title, Account.Name FROM Contact WHERE Name LIKE '%${like}%' OR Email LIKE '%${like}%' ORDER BY LastModifiedDate DESC LIMIT ${String(n)}`);
      const accounts = await query(api, `SELECT Id, Name, Industry FROM Account WHERE Name LIKE '%${like}%' ORDER BY LastModifiedDate DESC LIMIT ${String(n)}`);
      return {
        ok: true,
        contacts: contacts.slice(0, n).map((c) => {
          const r = asRecord(c);
          return { id: idStr(r['Id']), name: str(r['Name'], 200), email: str(r['Email'], 320), title: str(r['Title'], 200), accountName: str(asRecord(r['Account'])['Name'], 200) };
        }),
        accounts: accounts.slice(0, n).map((a) => {
          const r = asRecord(a);
          return { id: idStr(r['Id']), name: str(r['Name'], 200), industry: str(r['Industry'], 100) };
        }),
      };
    },
  },
  {
    name: 'salesforce.search_cases',
    provider: 'salesforce',
    service: 'records',
    kind: 'read',
    description: `Search Salesforce cases by words in the subject or by case number, and optionally by status. Newest change first.${untrusted}`,
    input: z.strictObject({ query: searchWords, status: caseStatus.optional(), limit }),
    async run(api, input) {
      const i = input as { query: string; status?: string };
      const { limit: n } = Q(input);
      const like = soqlString(i.query, true).slice(1, -1);
      const status = i.status ? ` AND Status = ${soqlString(i.status)}` : '';
      const rows = await query(api, `SELECT Id, CaseNumber, Subject, Status, Priority, ContactId, LastModifiedDate FROM Case WHERE (Subject LIKE '%${like}%' OR CaseNumber = ${soqlString(i.query)})${status} ORDER BY LastModifiedDate DESC LIMIT ${String(n)}`);
      return { ok: true, cases: rows.slice(0, n).map(sfCase) };
    },
  },
  {
    name: 'salesforce.read_case',
    provider: 'salesforce',
    service: 'records',
    kind: 'read',
    description: `Read one Salesforce case by the id a search answered: its details and its latest comments (each says whether the customer can see it).${untrusted}`,
    input: z.strictObject({ caseId: salesforceId('case') }),
    async run(api, input) {
      const id = String(input['caseId']);
      const doc = asRecord(await api.json(`/sobjects/Case/${enc(id)}`, { query: { fields: 'Id,CaseNumber,Subject,Description,Status,Priority,Origin,ContactId,CreatedDate,LastModifiedDate' } }));
      // the id was checked to be letters and digits only, so it is safe in the query as a quoted literal as well
      const comments = await query(api, `SELECT Id, CommentBody, IsPublished, CreatedDate FROM CaseComment WHERE ParentId = ${soqlString(id)} ORDER BY CreatedDate DESC LIMIT 20`);
      return {
        ok: true,
        case: { ...sfCase(doc), origin: str(doc['Origin'], 40), created: str(doc['CreatedDate'], 40), description: clip(str(doc['Description'], 40_000) ?? '', 2000).text },
        comments: comments
          .map((c) => {
            const r = asRecord(c);
            return { id: idStr(r['Id']), public: r['IsPublished'] === true, created: str(r['CreatedDate'], 40), text: clip(str(r['CommentBody'], 40_000) ?? '', 2000).text.slice(0, 2000) };
          })
          .reverse(),
      };
    },
  },
  {
    name: 'salesforce.add_case_note',
    provider: 'salesforce',
    service: 'records',
    kind: 'write',
    description: "Add an internal comment to a Salesforce case: it is not published to the customer. Needs the person's approval.",
    input: z.strictObject({ caseId: salesforceId('case'), body: noteText('The text of the comment (4,000 characters at most in Salesforce; 2,000 here).') }),
    card: (i) => textCard(`Add an internal note to Salesforce case ${String(i['caseId'])}`, String(i['body']), { case: String(i['caseId']), visibility: 'Internal comment: not published to the customer' }),
    async run(api, input) {
      const i = input as { caseId: string; body: string };
      const doc = asRecord(await api.json('/sobjects/CaseComment', { method: 'POST', body: { ParentId: i.caseId, CommentBody: i.body, IsPublished: false } }));
      return { ok: doc['success'] !== false, caseId: i.caseId, commentId: idStr(doc['id']) };
    },
  },
  {
    name: 'salesforce.set_case_status',
    provider: 'salesforce',
    service: 'records',
    kind: 'write',
    description: "Change the status of a Salesforce case to one of the statuses the org uses (Working, Escalated, Closed, ...). Salesforce refuses a status the org does not have. Needs the person's approval.",
    input: z.strictObject({ caseId: salesforceId('case'), status: caseStatus }),
    card: (i) => cardOf(`Set Salesforce case ${String(i['caseId'])} to “${String(i['status'])}”`, { case: String(i['caseId']), status: String(i['status']) }),
    async run(api, input) {
      const i = input as { caseId: string; status: string };
      await api.json(`/sobjects/Case/${enc(i.caseId)}`, { method: 'PATCH', body: { Status: i.status } });
      return { ok: true, caseId: i.caseId, status: i.status };
    },
  },
];

export const CRM_TOOLS: PersonToolDef[] = [...HUBSPOT_TOOLS, ...SALESFORCE_TOOLS];
