/**
 * Checksum validators for PII types whose value pattern alone is not selective enough.
 * @module validators
 */

import { PIIType } from './types.js';

/**
 * PESEL checksum validation
 * @param pesel - PESEL number to validate
 * @returns True if valid, false otherwise
 */
export function validatePESEL(pesel: string): boolean {
  /* c8 ignore next — PESEL regex /\b\d{11}\b/ always matches exactly 11 digits */
  if (pesel.length !== 11) return false;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(pesel[i]) * weights[i];
  }
  const checksum = (10 - (sum % 10)) % 10;
  return checksum === parseInt(pesel[10]);
}

/**
 * NIP checksum validation
 * @param nip - NIP number to validate
 * @returns True if valid, false otherwise
 */
export function validateNIP(nip: string): boolean {
  /* c8 ignore next — NIP regex /\b\d{10}\b/ always matches exactly 10 digits */
  if (nip.length !== 10) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(nip[i]) * weights[i];
  }
  const checksum = sum % 11;
  return checksum === parseInt(nip[9]);
}

/**
 * Luhn algorithm for credit card validation
 * @param number - Card number to validate
 * @returns True if valid, false otherwise
 */
export function validateLuhn(number: string): boolean {
  const digits = number.replace(/\D/g, '');
  /* c8 ignore next — CARD regex constrains to 13–19 digit patterns */
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let isEven = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i]);
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

/**
 * IBAN validation (mod 97 check)
 * @param iban - IBAN to validate
 * @returns True if valid, false otherwise
 */
export function validateIBAN(iban: string): boolean {
  const cleaned = iban.replace(/\s/g, '').toUpperCase();
  /* c8 ignore next — IBAN regex constrains to 15–34 character patterns */
  if (cleaned.length < 15 || cleaned.length > 34) return false;

  // Move first 4 chars to end
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);

  // Convert letters to numbers (A=10, B=11, etc.)
  let numericString = '';
  for (const char of rearranged) {
    if (char >= 'A' && char <= 'Z') {
      numericString += (char.charCodeAt(0) - 55).toString();
    } else {
      numericString += char;
    }
  }

  // Mod 97 check
  let remainder = 0;
  for (const digit of numericString) {
    remainder = (remainder * 10 + parseInt(digit)) % 97;
  }

  return remainder === 1;
}

/**
 * Validation functions for PII types that have checksums
 */
export const PII_VALIDATORS: Partial<Record<PIIType, (value: string) => boolean>> = {
  [PIIType.PESEL]: validatePESEL,
  [PIIType.NIP]: validateNIP,
  [PIIType.CARD]: validateLuhn,
  [PIIType.IBAN]: validateIBAN,
};
