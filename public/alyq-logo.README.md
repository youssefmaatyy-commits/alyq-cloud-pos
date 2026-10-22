# ALYQ official receipt logo

The thermal receipt (`src/modules/pos/services/receipt.ts`) loads the brand
mark from:

```
/alyq-logo.png
```

## Setup

1. Take the **attached official ALYQ logo file** (gold `ALYQ | أَلِيق` +
   `INSPIRED BY YOU` on ivory) exactly as supplied.
2. Save it — unmodified, same proportions — as `public/alyq-logo.png`
   (next to this file). PNG with the original background is correct.
3. Rebuild. No code changes are needed.

## Storefront header artwork

The storefront header uses `/brand/alyq-logo-transparent.png`, a tightly
trimmed, transparent-background derivative of the same supplied artwork. It
preserves the original bilingual gold mark and proportions. The original
`/alyq-logo.png` remains unchanged for receipt compatibility; the derivative is
only for the storefront header so its square ivory canvas is not displayed.

## Behaviour

- The receipt centers the logo at a thermal-friendly size
  (`width: 118px; max-width: 58%; height: auto`) and never stretches it.
- If the file is missing, the `<img>` hides itself (`onerror`) and the
  receipt falls back to the text brand (`ALYQ | أَلِيق` + `Inspired by you`)
  so printing never breaks.
- Do NOT commit AI-generated or redrawn substitutes here — only the
  official artwork.
