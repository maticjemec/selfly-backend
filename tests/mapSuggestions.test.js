import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDedupeKey,
  hasEnoughEvidence,
  isSimilarText,
  parseMapSuggestionsResponse,
  prepareAnalysisMessages,
  validateMapSuggestions,
} from "../mapSuggestions.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

const messages = [
  { id: ID_A, text: "Ko grem v službo, me vedno stisne v prsih." },
  { id: ID_B, text: "Včeraj sem se spet zjutraj zelo ustrašil pred sestankom." },
  { id: ID_C, text: "Pogovor s prijateljem me je pomiril." },
];

const noExisting = [];

test("prepareAnalysisMessages keeps only user rows, trims and keeps chronological order", () => {
  const rows = [
    { id: ID_A, role: "user", text: "  prvo sporočilo  " },
    { id: ID_B, role: "assistant", text: "odgovor Lumi" },
    { id: ID_C, role: "user", text: "" },
  ];
  const result = prepareAnalysisMessages(rows);
  assert.deepEqual(result, [{ id: ID_A, text: "prvo sporočilo" }]);
});

test("prepareAnalysisMessages truncates long messages and caps total length", () => {
  const long = "a".repeat(2000);
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: `m${index}`,
    role: "user",
    text: long,
  }));
  const result = prepareAnalysisMessages(rows);
  assert.ok(result.every((row) => row.text.length <= 500));
  const total = result.reduce((sum, row) => sum + row.text.length, 0);
  assert.ok(total <= 6000);
  assert.ok(result.length <= 30);
});

test("hasEnoughEvidence requires two meaningful messages", () => {
  assert.equal(hasEnoughEvidence([{ id: ID_A, text: "ok" }]), false);
  assert.equal(
    hasEnoughEvidence([
      { id: ID_A, text: "ok" },
      { id: ID_B, text: "dovolj dolgo sporočilo" },
    ]),
    false
  );
  assert.equal(hasEnoughEvidence(messages.slice(0, 2)), true);
});

test("buildDedupeKey is stable across case and punctuation", () => {
  assert.equal(
    buildDedupeKey("trigger", "Sestanki me stresajo."),
    buildDedupeKey("trigger", "  sestanki  ME stresajo ")
  );
  assert.notEqual(
    buildDedupeKey("trigger", "Sestanki me stresajo."),
    buildDedupeKey("pattern", "Sestanki me stresajo.")
  );
});

test("buildDedupeKey does not contain the raw text", () => {
  assert.ok(!buildDedupeKey("trigger", "skrivnost").includes("skrivnost"));
});

test("isSimilarText flags near-duplicates and allows different text", () => {
  assert.equal(
    isSimilarText(
      "Sestanki v službi te spravljajo v stres",
      "Sestanki v službi te spravljajo v stres."
    ),
    true
  );
  assert.equal(isSimilarText("sestanki v službi", "pomoč prijatelja"), false);
});

test("parseMapSuggestionsResponse rejects malformed output", () => {
  assert.equal(parseMapSuggestionsResponse(null), null);
  assert.equal(parseMapSuggestionsResponse("ni json"), null);
  assert.equal(parseMapSuggestionsResponse('{"other": 1}'), null);
  assert.deepEqual(parseMapSuggestionsResponse('{"suggestions": []}'), []);
});

test("validateMapSuggestions accepts a well-formed trigger", () => {
  const raw = [
    {
      kind: "trigger",
      text: "Zdi se, da sestanki v službi sprožijo napetost.",
      evidence_message_ids: [ID_A],
    },
  ];
  const result = validateMapSuggestions(raw, { messages, existingItems: noExisting });
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "trigger");
  assert.deepEqual(result[0].evidenceMessageIds, [ID_A]);
  assert.equal(typeof result[0].dedupeKey, "string");
});

test("validateMapSuggestions rejects a pattern supported by one message", () => {
  const raw = [
    {
      kind: "pattern",
      text: "Zdi se, da se pogosto ustrašiš.",
      evidence_message_ids: [ID_B],
    },
  ];
  assert.deepEqual(
    validateMapSuggestions(raw, { messages, existingItems: noExisting }),
    []
  );
});

test("validateMapSuggestions accepts a pattern with two evidence messages", () => {
  const raw = [
    {
      kind: "pattern",
      text: "Zdi se, da se pred sestanki pojavi strah.",
      evidence_message_ids: [ID_A, ID_B],
    },
  ];
  assert.equal(
    validateMapSuggestions(raw, { messages, existingItems: noExisting }).length,
    1
  );
});

test("validateMapSuggestions drops unknown or duplicated evidence ids", () => {
  const unknown = [
    {
      kind: "strength",
      text: "Zdi se, da ti pomaga pogovor s prijateljem.",
      evidence_message_ids: ["99999999-9999-4999-8999-999999999999"],
    },
  ];
  const duplicated = [
    {
      kind: "strength",
      text: "Zdi se, da ti pomaga pogovor s prijateljem.",
      evidence_message_ids: [ID_C, ID_C],
    },
  ];
  assert.deepEqual(
    validateMapSuggestions(unknown, { messages, existingItems: noExisting }),
    []
  );
  assert.deepEqual(
    validateMapSuggestions(duplicated, { messages, existingItems: noExisting }),
    []
  );
});

test("validateMapSuggestions rejects unknown kinds and diagnostic language", () => {
  const raw = [
    { kind: "emotion", text: "Zdi se, da si tesen.", evidence_message_ids: [ID_A] },
    {
      kind: "trigger",
      text: "To kaže na anksiozno motnjo.",
      evidence_message_ids: [ID_A],
    },
    {
      kind: "trigger",
      text: "Verjetno imaš depresijo zaradi službe.",
      evidence_message_ids: [ID_A],
    },
  ];
  assert.deepEqual(
    validateMapSuggestions(raw, { messages, existingItems: noExisting }),
    []
  );
});

test("validateMapSuggestions skips suggestions already known or rejected", () => {
  const existingItems = [
    {
      kind: "trigger",
      text: "Sestanki v službi sprožijo napetost.",
      status: "rejected",
      dedupeKey: buildDedupeKey("trigger", "Zdi se, da sestanki sprožijo napetost."),
    },
  ];
  const raw = [
    {
      kind: "trigger",
      text: "Zdi se, da sestanki sprožijo napetost.",
      evidence_message_ids: [ID_A],
    },
    {
      kind: "trigger",
      text: "Sestanki v službi sprožijo napetost!",
      evidence_message_ids: [ID_A],
    },
  ];
  assert.deepEqual(validateMapSuggestions(raw, { messages, existingItems }), []);
});

test("validateMapSuggestions removes near-duplicates within one batch and caps at three", () => {
  const raw = [
    { kind: "strength", text: "Pogovor s prijateljem te pomirja.", evidence_message_ids: [ID_C] },
    { kind: "strength", text: "Pogovor s prijateljem te pomirja!", evidence_message_ids: [ID_C] },
    { kind: "trigger", text: "Sestanki v službi te obremenjujejo.", evidence_message_ids: [ID_A] },
    { kind: "trigger", text: "Jutra pred delom so zate težka.", evidence_message_ids: [ID_B] },
    { kind: "trigger", text: "Nov predlog o nečem drugem.", evidence_message_ids: [ID_B] },
  ];
  const result = validateMapSuggestions(raw, { messages, existingItems: noExisting });
  assert.equal(result.length, 3);
});

test("validateMapSuggestions returns an empty list for an empty model answer", () => {
  assert.deepEqual(
    validateMapSuggestions([], { messages, existingItems: noExisting }),
    []
  );
});
