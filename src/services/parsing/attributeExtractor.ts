import { AttributeMap } from "../../types/build";

function normalizeKey(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*[:\-–]\s*/g, " ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function storeAttribute(map: AttributeMap, rawKey: string, value: string): void {
  if (!rawKey || !value) return;
  const key = normalizeKey(rawKey);
  const trimmedValue = value.trim();
  if (!trimmedValue) return;
  map[key] = trimmedValue;
}

export function detectAttributes(rawText: string): AttributeMap {
  const attributes: AttributeMap = {};
  if (!rawText) return attributes;

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\u00A0/g, " ").trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const colonMatch = line.match(/^(.+?)[\s:–\-]+(.+)$/);
    if (colonMatch) {
      storeAttribute(attributes, colonMatch[1], colonMatch[2]);
      continue;
    }

    const pipeParts = line.split("|").map((part) => part.trim()).filter(Boolean);
    if (pipeParts.length >= 2) {
      storeAttribute(attributes, pipeParts[0], pipeParts.slice(1).join(" | "));
      continue;
    }

    const tabParts = line.split(/\t+/).map((part) => part.trim()).filter(Boolean);
    if (tabParts.length >= 2) {
      storeAttribute(attributes, tabParts[0], tabParts.slice(1).join(" "));
      continue;
    }

    const spacedParts = line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
    if (spacedParts.length >= 2) {
      storeAttribute(attributes, spacedParts[0], spacedParts.slice(1).join(" "));
      continue;
    }

    const softMatch = line.match(/^([A-Za-z0-9\/ ]{1,30})\s+(.+)$/);
    if (softMatch && /[A-Za-z]/.test(softMatch[1]) && softMatch[2].length > 0) {
      storeAttribute(attributes, softMatch[1], softMatch[2]);
    }
  }

  return attributes;
}

