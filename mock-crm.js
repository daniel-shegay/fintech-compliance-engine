'use strict';

/**
 * Mock CRM Data Adapter
 *
 * Provides realistic synthetic loan and debt data for local development,
 * interview presentations, and testing without requiring live CRM credentials.
 */

const fs = require('fs');
const path = require('node:path');
const crypto = require('node:crypto');

function isMockMode() {
  const apiKey = (process.env.API_KEY || '').trim();
  const mockEnv = (process.env.MOCK_MODE || '').toLowerCase();
  return (
    mockEnv === 'true' ||
    mockEnv === '1' ||
    !apiKey ||
    apiKey.includes('your_') ||
    apiKey === 'rehearsal-key'
  );
}

// -----------------------------------------------------------------------------
// Synthetic Loan Records (Overview Table 234 & Payments Table 230 representation)
// -----------------------------------------------------------------------------

function getMockClientData(customerId) {
  const cid = String(customerId || '1001');

  // Customer 1002 is a demo case for "Sold to collection agency"
  if (cid === '1002') {
    return {
      customerId: cid,
      loans: [
        {
          id: '2004',
          product: 'Půjčka na míru',
          status: 'Postoupeno / prodáno',
          prodan: true,
          klient: Number(cid),
          origin: null,
          schval: '2025-05-10',
          splatn: '2025-06-10',
          vprodl: 420,
          jistina: 15000,
          platba: 2500,
          uhrJist: 1000,
          writeoff: 0,
          castProd: 0, castProdU: 0,
          naklPujc: 3000, naklPujcU: 1500,
          smlPok: 2000, smlPokU: 0,
          kompUrk: 1250, kompUrkU: 0,
          upomink: 500, upominkU: 0,
          inkasni: 1500, inkasniU: 0,
          vymah: 2000, vymahU: 0,
          dluh: 23250,
          chainOpen: false,
        },
      ],
      totalJistina: 15000,
      hasWriteoff: false,
      meta: { loanCount: 1, mock: true },
    };
  }

  // Default demo customer 1001 (or any other ID):
  // 3 loans showing: 1 active open debt, 1 extension child loan, 1 repaid historical loan
  const loans = [
    {
      id: '2001',
      product: 'Standardní půjčka',
      status: 'Vymáhání',
      prodan: false,
      klient: Number(cid),
      origin: null,
      schval: '2026-01-15',
      splatn: '2026-02-15',
      vprodl: 185,
      jistina: 20000,
      platba: 15000,
      uhrJist: 15000,
      writeoff: 0,
      castProd: 1000, castProdU: 1000,
      naklPujc: 2500, naklPujcU: 2000,
      smlPok: 220, smlPokU: 0,
      kompUrk: 197.26, kompUrkU: 0,
      upomink: 500, upominkU: 0,
      inkasni: 1500, inkasniU: 1500,
      vymah: 2000, vymahU: 0,
      dluh: 9471.26,
      chainOpen: true,
    },
    {
      id: '2002',
      product: 'Prodloužení splatnosti',
      status: 'Splaceno',
      prodan: false,
      klient: Number(cid),
      origin: '2001', // Extension of loan 2001
      schval: '2026-02-14',
      splatn: '2026-03-14',
      vprodl: 0,
      jistina: 0, // Extension does not create new principal
      platba: 3000,
      uhrJist: 0,
      writeoff: 0,
      castProd: 3000, castProdU: 3000,
      naklPujc: 0, naklPujcU: 0,
      smlPok: 0, smlPokU: 0,
      kompUrk: 0, kompUrkU: 0,
      upomink: 0, upominkU: 0,
      inkasni: 0, inkasniU: 0,
      vymah: 0, vymahU: 0,
      dluh: 0,
      chainOpen: false,
    },
    {
      id: '2003',
      product: 'Mikropůjčka',
      status: 'Splaceno',
      prodan: false,
      klient: Number(cid),
      origin: null,
      schval: '2025-08-01',
      splatn: '2025-09-01',
      vprodl: 0,
      jistina: 10000,
      platba: 12000,
      uhrJist: 10000,
      writeoff: 0,
      castProd: 0, castProdU: 0,
      naklPujc: 2000, naklPujcU: 2000,
      smlPok: 0, smlPokU: 0,
      kompUrk: 0, kompUrkU: 0,
      upomink: 0, upominkU: 0,
      inkasni: 0, inkasniU: 0,
      vymah: 0, vymahU: 0,
      dluh: 0,
      chainOpen: false,
    },
  ];

  return {
    customerId: cid,
    loans,
    totalJistina: 30000,
    hasWriteoff: false,
    meta: { loanCount: loans.length, mock: true },
  };
}

// -----------------------------------------------------------------------------
// Synthetic Export 229 Rows (for Write-off Balance & Waterfall Engine)
// -----------------------------------------------------------------------------

function getMockCreditRows({ customerId, creditId }) {
  const cid = String(customerId || '1001');
  const crid = String(creditId || '2001');

  // Credit 2001: 9,471.26 Kč debt perfectly reconciled down to haléře
  const row2001 = {
    id: '2001',
    customer_id: cid,
    charge: '2500.00',
    amount: '20000.00',
    debt: '9471.26',
    r_debt: '9471.26',
    writeoff: '0.00',
    writeoff_a: '0.00',
    writeoff_l: '0.00',
    writeoff_p: '0.00',
    penalty: '0.00',
    late_fee: '220.00',
    court_date: '0000-00-00',
    cfg_court: '0',
    sold: '0000-00-00',
    archive: '0',
    important: '0',
    current_delay: '185',
    l_amount: '5000.00',      // Principal remainder
    l_interest: '500.00',     // Fee/charge remainder
    r_charge: '500.00',
    l_cinterest: '197.26',    // Statutory default interest
    l_late_fee: '220.00',     // Contractual penalty
    l_percent: '0.00',
    l_tax1: '0.00',
    l_tax2: '500.00',
    l_tax3: '0.00',
    l_tax4: '0.00',
    l_tax5: '1000.00',
    l_tax6: '0.00',
    l_tax7: '0.00',
    l_tax8: '0.00',
    l_tax9: '0.00',
    l_tax10: '1000.00',
    l_tax11: '400.00',
    l_tax12: '654.00',
    l_administrative_fee: '0.00',
    l_penalty: '0.00',
    cinterest: '197.26',
  };

  const row2004 = {
    id: '2004',
    customer_id: cid,
    charge: '3000.00',
    amount: '15000.00',
    debt: '23250.00',
    r_debt: '23250.00',
    writeoff: '0.00',
    sold: '2025-05-10',
    archive: '0',
    current_delay: '420',
    l_amount: '14000.00',
    l_interest: '1500.00',
    r_charge: '1500.00',
    l_cinterest: '1250.00',
    l_late_fee: '2000.00',
    l_tax6: '1500.00',
    l_tax8: '2000.00',
    l_tax10: '1000.00',
  };

  const rows = [row2001, row2004];
  if (creditId) {
    return rows.filter((r) => String(r.id) === crid);
  }
  return rows;
}

module.exports = {
  isMockMode,
  getMockClientData,
  getMockCreditRows,
};
