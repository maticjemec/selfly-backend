const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function validateMapSuggestionRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      error: {
        status: 400,
        code: "INVALID_REQUEST_BODY",
        message: "Neveljavna zahteva.",
      },
    };
  }

  const { conversationId } = body;

  if (conversationId === undefined || conversationId === null || conversationId === "") {
    return {
      error: {
        status: 400,
        code: "MISSING_CONVERSATION_ID",
        message: "Manjka ID pogovora.",
      },
    };
  }

  if (!isValidUuid(conversationId)) {
    return {
      error: {
        status: 400,
        code: "INVALID_CONVERSATION_ID",
        message: "Neveljaven ID pogovora.",
      },
    };
  }

  return { conversationId };
}
