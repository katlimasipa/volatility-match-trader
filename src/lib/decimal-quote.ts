const MAX_DECIMAL_PLACES = 10;

/** Formats a Deriv quote without relying on binary floating-point toFixed rounding. */
export function decimalQuote(quote: number | string, decimalPlaces: number): string | null {
  const places = Number.isInteger(decimalPlaces)
    ? Math.max(0, Math.min(MAX_DECIMAL_PLACES, decimalPlaces))
    : 0;
  const raw = String(quote).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(raw);
  if (!match) return null;

  const negative = match[1] === "-";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;

  const digits = BigInt(`${integer}${fraction}` || "0");
  const shift = places + exponent - fraction.length;
  let scaled: bigint;
  if (shift >= 0) {
    scaled = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    scaled = (digits + divisor / 2n) / divisor;
  }

  const fixed = scaled.toString().padStart(places + 1, "0");
  const formatted = places ? `${fixed.slice(0, -places)}.${fixed.slice(-places)}` : fixed;
  return negative && scaled > 0n ? `-${formatted}` : formatted;
}

export function digitFromQuote(quote: number | string, decimalPlaces: number): number | null {
  const formatted = decimalQuote(quote, decimalPlaces);
  if (!formatted) return null;
  const finalDigit = formatted.at(-1);
  return finalDigit && /\d/.test(finalDigit) ? Number(finalDigit) : null;
}

export function finalQuoteDigits(
  quote: number | string,
  decimalPlaces: number,
  count: number,
): string | null {
  if (!Number.isInteger(count) || count < 1 || count > 10) return null;
  const formatted = decimalQuote(quote, decimalPlaces);
  if (!formatted) return null;
  const digits = formatted.replace(/\D/g, "");
  return digits.slice(-count).padStart(count, "0");
}
