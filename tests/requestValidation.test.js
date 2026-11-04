import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMapSuggestionRequest } from "../requestValidation.js";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

test("request without a body returns 400 instead of throwing", () => {
  assert.equal(validateMapSuggestionRequest(undefined).error.status, 400);
  assert.equal(validateMapSuggestionRequest(undefined).error.code, "INVALID_REQUEST_BODY");
});

test("request with a non-object body returns 400", () => {
  for (const body of [null, "text", 42, ["a"]]) {
    const result = validateMapSuggestionRequest(body);
    assert.equal(result.error.code, "INVALID_REQUEST_BODY");
  }
});

test("missing or empty conversationId returns 400", () => {
  for (const body of [{}, { conversationId: null }, { conversationId: "" }]) {
    const result = validateMapSuggestionRequest(body);
    assert.equal(result.error.status, 400);
    assert.equal(result.error.code, "MISSING_CONVERSATION_ID");
  }
});

test("non-UUID conversationId returns 400", () => {
  for (const conversationId of ["abc", 123, { id: VALID_ID }, `${VALID_ID} `]) {
    const result = validateMapSuggestionRequest({ conversationId });
    assert.equal(result.error.status, 400);
    assert.equal(result.error.code, "INVALID_CONVERSATION_ID");
  }
});

test("valid UUID conversationId is returned", () => {
  assert.deepEqual(validateMapSuggestionRequest({ conversationId: VALID_ID }), {
    conversationId: VALID_ID,
  });
});
