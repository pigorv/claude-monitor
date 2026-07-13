import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from './constants.js';
import { MODEL_IDS, setDiscountRules, type DiscountRule } from './cost.js';
import * as logger from './logger.js';

/**
 * Resolve the path of the discount config file. Honors the
 * `CLAUDE_MONITOR_DISCOUNTS_FILE` env override, otherwise defaults to
 * `discounts.json` inside the app data directory (`~/.claude-monitor`).
 */
export function resolveDiscountsPath(): string {
  return process.env['CLAUDE_MONITOR_DISCOUNTS_FILE'] ?? join(DEFAULT_CONFIG.dataDir, 'discounts.json');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidRule(entry: unknown, path: string): entry is DiscountRule {
  if (typeof entry !== 'object' || entry === null) {
    logger.warn(`Skipping discount rule: not an object (in ${path})`, { entry });
    return false;
  }
  const rule = entry as Record<string, unknown>;

  if (typeof rule['model'] !== 'string' || !MODEL_IDS.includes(rule['model'])) {
    logger.warn(
      `Skipping discount rule: 'model' is not a known model id (in ${path})`,
      { model: rule['model'] },
    );
    return false;
  }

  if (
    typeof rule['percentOff'] !== 'number' ||
    !Number.isFinite(rule['percentOff']) ||
    rule['percentOff'] < 0 ||
    rule['percentOff'] > 100
  ) {
    logger.warn(
      `Skipping discount rule for ${rule['model']}: 'percentOff' must be a number in [0, 100] (in ${path})`,
      { percentOff: rule['percentOff'] },
    );
    return false;
  }

  if (rule['start'] !== undefined && (typeof rule['start'] !== 'string' || !ISO_DATE.test(rule['start']))) {
    logger.warn(
      `Skipping discount rule for ${rule['model']}: 'start' must be a YYYY-MM-DD date (in ${path})`,
      { start: rule['start'] },
    );
    return false;
  }

  if (rule['end'] !== undefined && (typeof rule['end'] !== 'string' || !ISO_DATE.test(rule['end']))) {
    logger.warn(
      `Skipping discount rule for ${rule['model']}: 'end' must be a YYYY-MM-DD date (in ${path})`,
      { end: rule['end'] },
    );
    return false;
  }

  if (
    typeof rule['start'] === 'string' &&
    typeof rule['end'] === 'string' &&
    rule['start'] > rule['end']
  ) {
    logger.warn(
      `Skipping discount rule for ${rule['model']}: 'start' is after 'end' (in ${path})`,
      { start: rule['start'], end: rule['end'] },
    );
    return false;
  }

  return true;
}

/**
 * Read, parse, and validate the discount config file. Never throws:
 * - Missing file ⇒ `[]` (not an error).
 * - Unreadable / malformed JSON / non-array top level ⇒ one warning, `[]`.
 * - Invalid entries ⇒ dropped with a warning each; valid siblings kept.
 * File order is preserved (first-match-wins depends on it).
 */
export function loadDiscountRules(): DiscountRule[] {
  const path = resolveDiscountsPath();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      logger.debug(`No discount config file at ${path}; no discounts applied.`);
      return [];
    }
    logger.warn(`Could not read discount config at ${path}; no discounts applied.`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(`Discount config at ${path} is not valid JSON; no discounts applied.`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn(`Discount config at ${path} must be a JSON array; no discounts applied.`);
    return [];
  }

  return parsed.filter((entry): entry is DiscountRule => isValidRule(entry, path));
}

/**
 * Load discount rules from the config file and install them into the pricing
 * choke point (`setDiscountRules`). Node-only; run once at CLI startup before
 * any command touches the database.
 */
export function initDiscounts(): void {
  setDiscountRules(loadDiscountRules());
}
