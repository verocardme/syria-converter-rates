#!/usr/bin/env node
/**
 * Auto-update SYP/USD rate in rates.json using Firecrawl to scrape sp-today.com.
 *
 * - Reads FIRECRAWL_API_KEY from the environment.
 * - Scrapes https://sp-today.com/en and extracts the USD buy/sell prices.
 * - Validates the new buy price (positive, within 20% of the current sypPerUsd).
 * - On success, updates sypPerUsd / updatedAt / source and writes rates.json
 *   back preserving its original indentation. Nothing else in the file changes.
 * - On any validation failure, logs a clear error and exits non-zero WITHOUT
 *   touching rates.json.
 *
 * Requires Node 20+ (uses the built-in global fetch — no external deps).
 */

const fs = require('fs');
const path = require('path');

const RATES_PATH = path.join(__dirname, '..', 'rates.json');
const FIRECRAWL_URL = 'https://api.firecrawl.dev/v2/scrape';
const SOURCE_URL = 'https://sp-today.com/en';
const MAX_DEVIATION = 0.2; // reject a new rate that differs from current by >20%

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

/**
 * Detect the first-level indentation string used in the raw JSON text so we can
 * write the file back byte-identically (aside from the values we change).
 * Falls back to 2 spaces if it can't be determined.
 */
function detectIndent(raw) {
  const match = raw.match(/\n([ \t]+)"/);
  return match ? match[1] : '  ';
}

async function scrapeRate(apiKey) {
  const body = {
    url: SOURCE_URL,
    formats: [
      {
        type: 'json',
        schema: {
          type: 'object',
          properties: {
            usd_buy_syp: { type: 'number' },
            usd_sell_syp: { type: 'number' },
          },
          required: ['usd_buy_syp', 'usd_sell_syp'],
        },
        prompt:
          "Find the USD (US Dollar) row in the 'Current Rates' table. Extract the Buy price in Syrian Pounds as usd_buy_syp and the Sell price as usd_sell_syp. These are large numbers like 13000, not decimals.",
      },
    ],
  };

  let response;
  try {
    response = await fetch(FIRECRAWL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    fail(`Network error calling Firecrawl: ${err.message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    fail(`Firecrawl returned HTTP ${response.status}: ${text}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    fail(`Could not parse Firecrawl response as JSON: ${text}`);
  }

  if (payload.success === false) {
    fail(`Firecrawl reported failure: ${JSON.stringify(payload)}`);
  }

  // v2 scrape returns the extracted object under data.json
  const extracted = payload?.data?.json ?? payload?.data?.extract ?? payload?.json;
  if (!extracted || typeof extracted !== 'object') {
    fail(`Firecrawl response did not contain extracted JSON: ${JSON.stringify(payload)}`);
  }

  return extracted;
}

async function main() {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    fail('FIRECRAWL_API_KEY is not set in the environment.');
  }

  // Read current rates.json (raw, so we can preserve its formatting).
  let raw;
  try {
    raw = fs.readFileSync(RATES_PATH, 'utf8');
  } catch (err) {
    fail(`Could not read rates.json at ${RATES_PATH}: ${err.message}`);
  }

  let rates;
  try {
    rates = JSON.parse(raw);
  } catch (err) {
    fail(`rates.json is not valid JSON: ${err.message}`);
  }

  const currentRate = rates.sypPerUsd;
  if (typeof currentRate !== 'number' || currentRate <= 0) {
    fail(`Current sypPerUsd in rates.json is not a positive number: ${currentRate}`);
  }

  const extracted = await scrapeRate(apiKey);
  const newRate = extracted.usd_buy_syp;
  const sellRate = extracted.usd_sell_syp;

  console.log(`Scraped from sp-today.com  -> usd_buy_syp: ${newRate}, usd_sell_syp: ${sellRate}`);
  console.log(`Current rates.json          -> sypPerUsd: ${currentRate}`);

  // --- Validation ------------------------------------------------------------
  if (typeof newRate !== 'number' || !Number.isFinite(newRate) || newRate <= 0) {
    fail(`Scraped usd_buy_syp is not a positive number: ${newRate}. Leaving rates.json unchanged.`);
  }

  const deviation = Math.abs(newRate - currentRate) / currentRate;
  if (deviation > MAX_DEVIATION) {
    fail(
      `Scraped rate ${newRate} deviates ${(deviation * 100).toFixed(1)}% from current ${currentRate} ` +
        `(max allowed ${(MAX_DEVIATION * 100).toFixed(0)}%). Refusing to update rates.json.`
    );
  }

  const rateChanged = newRate !== currentRate;
  if (rateChanged) {
    console.log(`Rate changed: ${currentRate} -> ${newRate}`);
  } else {
    console.log(`Rate unchanged at ${currentRate}, refreshing timestamp only`);
  }

  // --- Write back, preserving indentation and trailing newline ---------------
  // Always refresh updatedAt on a successful scrape+validation — even when the
  // rate is identical — so the app's "last updated" reflects that the rate was
  // re-verified as current. This means a successful run always changes the file.
  const indent = detectIndent(raw);
  const hadTrailingNewline = raw.endsWith('\n');

  rates.sypPerUsd = newRate;
  rates.updatedAt = new Date().toISOString();
  rates.source = 'firecrawl-auto';

  let output = JSON.stringify(rates, null, indent);
  if (hadTrailingNewline) output += '\n';
  fs.writeFileSync(RATES_PATH, output, 'utf8');

  console.log(
    `✅ Wrote rates.json: sypPerUsd=${newRate} ` +
      `(${(deviation * 100).toFixed(1)}% ${rateChanged ? 'change' : 'diff'}). ` +
      `source="firecrawl-auto", updatedAt=${rates.updatedAt}`
  );
}

main().catch((err) => {
  fail(`Unexpected error: ${err && err.stack ? err.stack : err}`);
});
