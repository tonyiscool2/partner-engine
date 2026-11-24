import { experimental_evaluate as evaluate } from "ai";

// Jev (TypeSafe AI) is an evaluation model: it doesn't write text. It answers
// typed questions (choice / score / boolean) about the state you give it.
const listing = `4-unit in Macon, GA. Asking $525,000. 100% occupied, long-term tenants.
Retiring owner, owned free and clear since 1998. Owner will carry with 20% down,
6% interest, 5-year balloon. Price reduced twice. Status: Active.`;

const result = await evaluate({
  model: "typesafe-ai/jev",
  state: listing,
  questions: {
    sellerFinance: {
      type: "choice",
      instructions:
        "What does this listing say about the SELLER personally financing the purchase? Bank or lender financing is NOT seller financing.",
      criteria: {
        explicit_with_terms: "Seller financing offered with at least one stated term",
        explicit_no_terms: "Seller financing offered, no terms stated",
        open_to_consider: "Seller will consider seller financing or creative terms",
        none: "No seller financing mentioned, or cash/conventional only",
      },
    },
    condition: {
      type: "score",
      instructions: "Physical condition described in the listing",
      criteria: ["Turnkey", "Cosmetic updates", "Deferred maintenance", "Heavy rehab"],
    },
    active: { type: "boolean", instructions: "The listing is still actively for sale (not pending, contingent, or sold)" },
    freeAndClear: { type: "boolean", instructions: "The owner has no mortgage on the property" },
  },
});

const a = result.answers;
console.log("Model:", result.response.modelId);
console.log("Seller financing:", a.sellerFinance.choice, a.sellerFinance.probabilities);
console.log("Condition (0 best–3 worst):", a.condition.score.toFixed(2));
console.log("P(active):", a.active.probability.toFixed(2));
console.log("P(free and clear):", a.freeAndClear.probability.toFixed(2));
