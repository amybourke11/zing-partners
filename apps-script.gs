// ============================================================
// ZING Partner Manager — Google Apps Script Backend
// ServiceQUIK Inc. / zinglocal.github.io/zing-partners
// ============================================================
// ⚠️  PASTE YOUR STRIPE SECRET KEY HERE — use sk_test_ for testing, sk_live_ for production.
// Find it at: https://dashboard.stripe.com/apikeys → "Secret key"
const STRIPE_SK = 'sk_test_REPLACE_WITH_YOUR_KEY';

// ─────────────────────────────────────────────────────────────
// HTTP HANDLERS
// ─────────────────────────────────────────────────────────────

function doPost(e) {
  const out = handleRequest(e);
  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', app: 'ZING Partner Manager' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleRequest(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;

    switch (action) {
      case 'init':                   return initSheets();
      case 'getAll':                 return getAll();
      case 'saveSrc':                return saveSrc(body.src);
      case 'delSrc':                 return delRecord('LeadSources', body.id);
      case 'saveDeal':               return saveDeal(body.deal);
      case 'delDeal':                return delRecord('Deals', body.id);
      case 'saveInv':                return saveInv(body.inv);
      case 'charge':
      case 'createPaymentIntent':    return createPaymentIntent(body.amount, body.currency || 'usd', body.desc || body.description || '');
      case 'stripeInv':              return sendStripeInvoice(body);
      default:                       return { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// SHEET HELPERS
// Storage: each record is one row — col A = id, col B = full JSON
// ─────────────────────────────────────────────────────────────

function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function initSheets() {
  ['LeadSources', 'Deals', 'Invoices', 'Meta'].forEach(n => getSheet(n));
  const meta = getSheet('Meta');
  if (meta.getLastRow() === 0) {
    meta.appendRow(['ns', 1]);
    meta.appendRow(['nd', 1]);
    meta.appendRow(['ni', 1]);
  }
  return { ok: true };
}

function getMeta(key) {
  const meta = getSheet('Meta');
  if (meta.getLastRow() === 0) return null;
  const data = meta.getDataRange().getValues();
  for (const row of data) {
    if (row[0] === key) return row[1];
  }
  return null;
}

function setMeta(key, value) {
  const meta = getSheet('Meta');
  if (meta.getLastRow() > 0) {
    const data = meta.getDataRange().getValues();
    for (let i = 0; i < data.length; i++) {
      if (data[i][0] === key) {
        meta.getRange(i + 1, 2).setValue(value);
        return;
      }
    }
  }
  meta.appendRow([key, value]);
}

function getAllRecords(sheetName) {
  const sheet = getSheet(sheetName);
  if (sheet.getLastRow() === 0) return [];
  const data = sheet.getDataRange().getValues();
  const records = [];
  for (const row of data) {
    try {
      if (row[1]) records.push(JSON.parse(row[1]));
    } catch (e) {}
  }
  return records;
}

function saveRecord(sheetName, id, obj) {
  const sheet = getSheet(sheetName);
  const json = JSON.stringify(obj);
  if (sheet.getLastRow() > 0) {
    const ids = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().flat();
    const idx = ids.indexOf(id);
    if (idx >= 0) {
      sheet.getRange(idx + 1, 1, 1, 2).setValues([[id, json]]);
      return;
    }
  }
  sheet.appendRow([id, json]);
}

function delRecord(sheetName, id) {
  const sheet = getSheet(sheetName);
  if (sheet.getLastRow() === 0) return { ok: true };
  const ids = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().flat();
  const idx = ids.indexOf(id);
  if (idx >= 0) sheet.deleteRow(idx + 1);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// DATA OPERATIONS
// ─────────────────────────────────────────────────────────────

function getAll() {
  const sources  = getAllRecords('LeadSources');
  const deals    = getAllRecords('Deals');
  const invoices = getAllRecords('Invoices');
  const ns = getMeta('ns') || 1;
  const nd = getMeta('nd') || 1;
  const ni = getMeta('ni') || 1;
  return { sources, deals, invoices, ns, nd, ni };
}

function saveSrc(src) {
  if (!src || !src.id) return { error: 'Missing source data' };
  saveRecord('LeadSources', src.id, src);
  return { ok: true };
}

function saveDeal(deal) {
  if (!deal || !deal.id) return { error: 'Missing deal data' };
  saveRecord('Deals', deal.id, deal);
  return { ok: true };
}

function saveInv(inv) {
  if (!inv || !inv.id) return { error: 'Missing invoice data' };
  saveRecord('Invoices', inv.id, inv);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// STRIPE — PAYMENT INTENT
// Called by frontend as action='charge' with amount in cents
// ─────────────────────────────────────────────────────────────

function createPaymentIntent(amount, currency, description) {
  try {
    if (!amount || amount <= 0) {
      return { success: false, error: 'Invalid amount: must be > 0 cents' };
    }

    const payload = [
      'amount='      + Math.round(amount),
      'currency='    + (currency || 'usd'),
      'description=' + encodeURIComponent(description || 'ZING payment'),
      // allow_redirects=off means no redirect-based payment methods (cards only)
      'automatic_payment_methods[enabled]=true',
      'automatic_payment_methods[allow_redirects]=off'
    ].join('&');

    const response = UrlFetchApp.fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + STRIPE_SK,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      payload: payload,
      muteHttpExceptions: true
    });

    const data = JSON.parse(response.getContentText());

    if (data.error) {
      return { success: false, error: data.error.message };
    }

    // Frontend expects { clientSecret: '...' }
    return { success: true, clientSecret: data.client_secret };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// STRIPE — INVOICE
// ─────────────────────────────────────────────────────────────

function sendStripeInvoice(params) {
  try {
    const { cn, ce, lines, desc, amount, due, notes } = params;

    if (!ce) return { ok: false, error: 'Customer email required' };

    // 1. Find or create Stripe customer
    const customerId = findOrCreateStripeCustomer(cn, ce);

    // 2. Compute due date as Unix timestamp
    const dueTs = due
      ? Math.floor(new Date(due).getTime() / 1000)
      : Math.floor(Date.now() / 1000) + 14 * 86400;

    // 3. Create invoice shell
    const invPayload = [
      'customer='          + customerId,
      'collection_method=send_invoice',
      'due_date='          + dueTs,
      notes ? 'description=' + encodeURIComponent(notes) : ''
    ].filter(Boolean).join('&');

    const invResponse = UrlFetchApp.fetch('https://api.stripe.com/v1/invoices', {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + STRIPE_SK,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      payload: invPayload,
      muteHttpExceptions: true
    });
    const inv = JSON.parse(invResponse.getContentText());
    if (inv.error) return { ok: false, error: inv.error.message };

    // 4. Add line items (lines array from frontend, or single amount)
    const items = lines && lines.length
      ? lines
      : [{ d: desc || 'ZING service', q: 1, a: (amount || 0) / 100 }];

    for (const item of items) {
      const cents = Math.round((parseFloat(item.a) || 0) * (parseInt(item.q) || 1) * 100);
      if (cents <= 0) continue;
      UrlFetchApp.fetch('https://api.stripe.com/v1/invoiceitems', {
        method: 'post',
        headers: {
          'Authorization': 'Bearer ' + STRIPE_SK,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        payload: [
          'customer=' + customerId,
          'invoice='  + inv.id,
          'amount='   + cents,
          'currency=usd',
          'description=' + encodeURIComponent(item.d || 'Service')
        ].join('&'),
        muteHttpExceptions: true
      });
    }

    // 5. Finalize invoice
    UrlFetchApp.fetch('https://api.stripe.com/v1/invoices/' + inv.id + '/finalize', {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + STRIPE_SK, 'Content-Type': 'application/x-www-form-urlencoded' },
      payload: '',
      muteHttpExceptions: true
    });

    // 6. Send invoice email via Stripe
    UrlFetchApp.fetch('https://api.stripe.com/v1/invoices/' + inv.id + '/send', {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + STRIPE_SK, 'Content-Type': 'application/x-www-form-urlencoded' },
      payload: '',
      muteHttpExceptions: true
    });

    return { ok: true, id: inv.id };

  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function findOrCreateStripeCustomer(name, email) {
  // Search for existing customer by email
  const searchRes = UrlFetchApp.fetch(
    'https://api.stripe.com/v1/customers/search?query=' + encodeURIComponent('email:"' + email + '"'),
    {
      headers: { 'Authorization': 'Bearer ' + STRIPE_SK },
      muteHttpExceptions: true
    }
  );
  const searchData = JSON.parse(searchRes.getContentText());
  if (searchData.data && searchData.data.length > 0) {
    return searchData.data[0].id;
  }

  // Create new customer
  const createPayload = [
    'email=' + encodeURIComponent(email),
    name ? 'name=' + encodeURIComponent(name) : ''
  ].filter(Boolean).join('&');

  const createRes = UrlFetchApp.fetch('https://api.stripe.com/v1/customers', {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + STRIPE_SK,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    payload: createPayload,
    muteHttpExceptions: true
  });
  const customer = JSON.parse(createRes.getContentText());
  if (customer.error) throw new Error('Could not create Stripe customer: ' + customer.error.message);
  return customer.id;
}
