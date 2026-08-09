// ==========================================================================
// PRODUCT CATEGORY CLASSIFIER
// ==========================================================================
// This pharmacy's inventory has no explicit category field in use — but
// product names consistently lead with the dosage form (Tab/Syp/Cap/...)
// or a recognizable brand name (Lifebuoy, Cerelac, ...). This infers a
// category purely from the product name, with no database changes and no
// risk of stale data — the category always matches whatever the name says,
// because it's derived from it on the fly.
//
// Built by sampling the actual first-word tokens across 3,000+ existing
// product names, not guessed from scratch — "Other" is an honest fallback
// for whatever doesn't match a recognized pattern, not an error state.

export const CATEGORY_DEFS = [
  { id: "tablets", label: "Tablets", icon: "medication", tokens: ["TAB", "TA"] },
  { id: "capsules", label: "Capsules", icon: "pill", tokens: ["CAP"] },
  { id: "syrups", label: "Syrups & Drops", icon: "water_drop", tokens: ["SYP", "SYRUP", "SUS", "SUSP", "DROP", "DROPS", "DRP"] },
  { id: "injections", label: "Injections", icon: "vaccines", tokens: ["INJ"] },
  { id: "eyeear", label: "Eye & Ear Care", icon: "visibility", tokens: ["EYE"] },
  { id: "topical", label: "Creams, Gels & Ointments", icon: "healing", tokens: ["CREAM", "OINT", "OINTMENT", "OINMENT", "GEL", "GL", "LOTION"] },
  { id: "dental", label: "Dental Care", icon: "clean_hands", tokens: ["TP", "MW"] },
  { id: "respiratory", label: "Inhalers & Respiratory", icon: "air", tokens: ["INHALER"] },
  { id: "sachets", label: "Sachets & Rehydration", icon: "science", tokens: ["SAC", "SACHET", "ORS"] },
  { id: "vitamins", label: "Vitamins & Supplements", icon: "spa", tokens: ["NF", "CAC"] },
  { id: "herbal", label: "Herbal (Araq)", icon: "eco", tokens: ["ARQ"] },
  { id: "baby", label: "Baby & Nutrition", icon: "child_care", tokens: ["CERELAC", "LACTOGEN", "MORINAGA", "NUMIL", "INFANTALL", "MEIJI", "ENSURE", "BABY"] },
  { id: "personalcare", label: "Personal Care & Toiletries", icon: "storefront", tokens: ["LIFEBUOY", "SUNSILK", "PONDS", "DOVE", "SELSUN", "SHIELD"] },
];

export const OTHER_CATEGORY = { id: "other", label: "Other", icon: "category", tokens: [] };

// Flat token -> category lookup, built once.
const TOKEN_MAP = new Map();
CATEGORY_DEFS.forEach((cat) => {
  cat.tokens.forEach((t) => TOKEN_MAP.set(t, cat));
});

/**
 * Infers a category from a product name's first word. Pure function, no
 * side effects — safe to call on every render for every row.
 */
export function categorizeProduct(name) {
  if (!name) return OTHER_CATEGORY;
  const firstWord = name.trim().split(/\s+/)[0].toUpperCase().replace(/[.\-]+$/, "");
  return TOKEN_MAP.get(firstWord) || OTHER_CATEGORY;
}

export const ALL_CATEGORIES = [...CATEGORY_DEFS, OTHER_CATEGORY];
