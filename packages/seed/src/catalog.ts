// Invented fixture identities. These are never loaded from customer records.
export const businesses = [
  'Dar Al Wafa Hotels',
  'Rawda Suites',
  'Qamar Dunes Hospitality',
  'Sidr Courtyard Stays',
  'Bayt Al Rimal',
  'Nakhla Pearl Hotels',
  'Marsa Lantern Suites',
  'Wadi Saffron Retreats',
  'Rimal Crescent Hotels',
  'Layali Orchard Inns',
  'Safwa Amber Suites',
  'Dar Al Nujum',
  'Reem Palm Residences',
  'Sama Coral Hospitality',
  'Manzil Juniper Hotels',
  'Afnan Oasis Stays',
  'Durrat Meadow Suites',
  'Jisr Moonlight Hotels',
  'Riwaq Cedar Inns',
  'Bustan Lantern Resorts',
  'Tala Sandstone Hotels',
  'Misk Horizon Suites',
  'Naseem Courtyard Hotels',
  'Sahab Copper Retreats',
  'Yasmin Dunes Inns',
  'Fanar Orchard Suites',
  'Darb Pearl Residences',
  'Aseel Moonstone Hotels',
  'Rafif Palm Stays',
  'Najm Saffron Resorts',
];
export const roles = ['owner', 'admin', 'editor', 'marketer', 'revenue manager'];
const firstNames = [
  'Noura',
  'Faisal',
  'Mariam',
  'Omar',
  'Hessa',
  'Arjun',
  'Priya',
  'Imran',
  'Ayesha',
  'Rohan',
  'Sophie',
  'Daniel',
  'Amelia',
  'Lucas',
  'Sara',
];
const lastNames = ['Al-Harbi', 'Al-Qasimi', 'Al-Mazrouei', 'Al-Salem', 'Al-Rashidi', 'Kapoor', 'Menon', 'Rahman', 'Patel', 'Whitmore'];
export const users = Array.from({ length: 150 }, (_, i) => ({
  type: 'user',
  id: `usr_${i + 1}`,
  name: `${firstNames[i % 15]} ${lastNames[Math.floor(i / 15)]}`,
  email: `staff.${i + 1}@example.com`,
  role: roles[i % 5],
}));
export const support = ['Leena Ashford', 'Yusuf Varma', 'Hana Calder'];

export interface Action {
  action: string;
  verb: string;
  field: string;
  before: unknown;
  after: unknown;
}
// Action-specific diffs keep unrelated fields out of each event. These illustrative
// records are described in the dataset documentation at ../README.md.
function actions(rows: string): Action[] {
  return rows
    .trim()
    .split('\n')
    .map((line) => {
      const [action = '', verb = '', field = '', before = '', after = ''] = line.split('|');
      return { action, verb, field, before: JSON.parse(before), after: JSON.parse(after) };
    });
}
export const hospitalityActions = actions(`
auth.otp.requested|requested a sign-in code for|delivery|"none"|"email"
auth.otp.failed|failed repeated sign-in checks for|failedAttempts|4|5
auth.signed_in|signed in to|authenticated|false|true
auth.signed_out|signed out of|authenticated|true|false
auth.session.revoked|revoked a session for|revoked|false|true
member.invited|invited a colleague to|status|null|"PENDING"
member.role.changed|changed the member role for|role|"editor"|"admin"
member.removed|removed a member from|active|true|false
hotel.created|added|nameEn|null|"Rawda Courtyard Makkah"
hotel.policy.updated|changed the cancellation policy of|cancellationHours|24|48
hotel.published|published|isPublished|false|true
hotel.unpublished|unpublished|isPublished|true|false
hotel.check_in.updated|changed the check-in time of|checkInTime|"15:00"|"16:00"
hotel.facility.assigned|added a facility to|facility|null|"Airport shuttle"
hotel.room.assigned|assigned a room type to|roomType|null|"Deluxe King Room"
hotel.review.synced|synced review scores for|reviewsAverage|4.2|4.4
hotel.faq.updated|updated arrival guidance for|answer|"Reception closes at 23:00"|"Reception open 24 hours"
hotel.translated|translated the hotel name for|nameAr|null|"\u0623\u062c\u0646\u062d\u0629 \u0627\u0644\u0631\u0648\u0636\u0629"
room.created|created a room type for|capacity|null|2
room.capacity.updated|changed room capacity for|maxCapacity|2|3
room.amenity.assigned|added an amenity to|amenity|null|"Tea and coffee station"
room.enabled|enabled|isEnabled|false|true
room.rate.updated|changed the nightly rate of|nightlyRate|{"amount":450,"currency":"SAR"}|{"amount":520,"currency":"SAR"}
rate_plan.created|created a flexible rate for|cancellationHours|null|48
booking.created|received a reservation for|status|null|"CONFIRMED"
booking.modified|changed the stay dates of|startDate|"2026-11-12"|"2026-11-14"
booking.cancelled|cancelled|status|"CONFIRMED"|"CANCELLED"
booking.no_show|marked a no-show for|status|"CONFIRMED"|"NO_SHOW"
booking.hotel.linked|linked a hotel to|hotelId|null|"hotel_1_1"
booking.promo.attributed|attributed a promo code to|promoCode|null|"RAMADAN20"
guest.created|created a guest profile for|email|null|"guest.58213@example.com"
guest.updated|updated the preferred locale of|locale|"en"|"ar"
guest.merged|merged duplicate profiles for|mergedInto|null|"guest_1_27"
guest.tag.added|tagged|tag|null|"Returning guest"
guest.consent.updated|updated marketing consent for|marketingConsent|false|true
segment.created|created a returning-guest segment for|name|null|"Returning guests - 90 days"
segment.recomputed|recomputed audience membership for|members|124|138
campaign.created|created a campaign for|status|null|"DRAFT"
campaign.scheduled|scheduled a campaign for|status|"DRAFT"|"SCHEDULED"
campaign.sent|finished sending a campaign for|status|"SENDING"|"SENT"
campaign.cancelled|cancelled a campaign for|status|"SCHEDULED"|"CANCELLED"
campaign.failed|could not deliver a campaign for|status|"SENDING"|"FAILED"
campaign.subject.updated|edited the email subject for|subject|"Your next stay"|"Ramadan Early Booking 20%"
whatsapp.template.approved|received template approval for|status|"PENDING"|"APPROVED"
whatsapp.message.delivered|received a delivery receipt for|status|"SENT"|"DELIVERED"
whatsapp.message.failed|received a failed delivery receipt for|status|"SENT"|"FAILED"
whatsapp.consent.recorded|recorded WhatsApp consent for|consent|false|true
article.created|drafted|status|null|"DRAFT"
article.published|published|status|"DRAFT"|"PUBLISHED"
article.scheduled|scheduled publication of|status|"DRAFT"|"SCHEDULED"
article.archived|archived|status|"PUBLISHED"|"ARCHIVED"
article.restored|restored|deletedAt|"2026-10-14T09:00:00Z"|null
article.translated|translated|title|"Umrah Season Packages"|"\u0628\u0627\u0642\u0627\u062a \u0645\u0648\u0633\u0645 \u0627\u0644\u0639\u0645\u0631\u0629"
article.revision.restored|restored a revision of|revision|4|2
page.updated|updated the page title for|title|"Stay with us"|"Plan your Makkah stay"
page.deleted|deleted the theme page for|visible|true|false
website.created|created a website for|type|null|"HOTEL_B2C"
website.domain.connected|connected a domain for|domain|null|"rawda-suites.example.com"
website.published|published theme content for|published|false|true
website.screenshot.captured|captured a preview of|screenshot|null|"https://assets.example.com/previews/home.webp"
website.language.added|enabled Arabic for|languageCodes|["en"]|["en","ar"]
website.redirect.created|added a redirect for|destination|"/offers-old"|"/seasonal-offers"
integration.enabled|enabled booking sync for|isEnabled|false|true
integration.credential.rotated|rotated integration credentials for|credential|"[redacted]"|"[redacted]"
media.uploaded|uploaded a lobby photo for|filename|null|"courtyard-lobby-evening.webp"
media.optimized|optimized a lobby photo for|bytes|2480000|186000
media.alt.updated|updated image accessibility text for|alt|"Lobby"|"Lantern-lit courtyard reception"
guests.exported|exported guest records for|format|null|"CSV"
activity.exported|exported activity history for|format|null|"JSONL"
settings.updated|changed the default locale of|defaultLocale|"en"|"ar"
api_key.created|created an integration key for|token|null|"[redacted]"
api_key.revoked|revoked an integration key for|revoked|false|true
impersonation.started|opened a support session for|impersonating|false|true
impersonation.ended|closed a support session for|impersonating|true|false
promo_code.created|created a seasonal discount for|discountPercent|null|20
promo_code.disabled|disabled a discount for|isActive|true|false
contact_message.replied|replied to an enquiry for|status|"OPEN"|"REPLIED"
review.moderated|approved a guest review for|status|"PENDING"|"APPROVED"
`);
export const ledgerActions = actions(`
invoice.created|created|status|null|"DRAFT"
invoice.approved|approved|status|"PENDING_APPROVAL"|"APPROVED"
invoice.voided|voided|status|"APPROVED"|"VOID"
invoice.sent|sent|deliveryStatus|"QUEUED"|"SENT"
payment.received|recorded payment for|paidAmount|0|1250
payment.refunded|refunded|refundedAmount|0|250
payment.failed|could not settle|status|"PENDING"|"FAILED"
journal.posted|posted a balanced journal for|status|"DRAFT"|"POSTED"
journal.reversed|reversed|status|"POSTED"|"REVERSED"
vendor.created|created a supplier for|status|null|"ACTIVE"
vendor.bank_details.changed|changed bank details for|iban|"[redacted]"|"[redacted]"
account.closed|closed|status|"OPEN"|"CLOSED"
reconciliation.completed|completed reconciliation for|unmatched|7|0
expense.approved|approved an expense for|status|"SUBMITTED"|"APPROVED"
period.locked|locked the accounting period for|locked|false|true
`);
