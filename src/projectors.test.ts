import { describe, expect, test } from "bun:test"
import { message, part, routeBus, session } from "./projectors.js"

const sessionCreated = {
  type: "session.created" as const,
  properties: {
    sessionID: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
    info: {
      id: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
      slug: "gentle-meadow",
      version: "local",
      projectID: "global",
      directory: "/tmp/oc-phase55-a/project",
      title: "New session - 2026-04-04T10:31:44.822Z",
      time: { created: 1775298704822, updated: 1775298704822 },
    },
  },
}

const sessionUpdated = {
  type: "session.updated" as const,
  properties: {
    sessionID: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
    info: {
      id: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
      slug: "gentle-meadow",
      version: "local",
      projectID: "global",
      directory: "/tmp/oc-phase55-a/project",
      title: "Updated title",
      time: { created: 1775298704822, updated: 1775298704996 },
      share: { url: "https://share.example/session" },
    },
  },
}

const sessionDeleted = {
  type: "session.deleted" as const,
  properties: {
    sessionID: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
    info: { id: "ses_2a7f38a49ffeypaIAg9KzGPvn0" },
  },
}

const messageUpdated = {
  type: "message.updated" as const,
  properties: {
    sessionID: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
    info: {
      id: "msg_d580c764f001G9t1LZZWDH5pVx",
      role: "user",
      sessionID: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
      time: { created: 1775298704975 },
      agent: "Sisyphus (Ultraworker)",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      variant: "max",
    },
  },
}

const messageRemoved = {
  type: "message.removed" as const,
  properties: {
    sessionID: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
    messageID: "msg_d580c764f001G9t1LZZWDH5pVx",
  },
}

const partUpdated = {
  type: "message.part.updated" as const,
  properties: {
    sessionID: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
    part: {
      type: "text",
      text: "phase55 one",
      messageID: "msg_d580c764f001G9t1LZZWDH5pVx",
      sessionID: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
      id: "prt_d580c7651001B2j8ZKav8eytrG",
    },
    time: 1775298704994,
  },
}

const partRemoved = {
  type: "message.part.removed" as const,
  properties: {
    sessionID: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
    messageID: "msg_d580c764f001G9t1LZZWDH5pVx",
    partID: "prt_d580c7651001B2j8ZKav8eytrG",
  },
}

describe("projector field mapping against bus payloads", () => {
  test("session.created maps nested time.created and time.updated", () => {
    const row = session(sessionCreated.properties.info)

    expect(row.id).toBe("ses_2a7f38a49ffeypaIAg9KzGPvn0")
    expect(row.project_id).toBe("global")
    expect(row.slug).toBe("gentle-meadow")
    expect(row.directory).toBe("/tmp/oc-phase55-a/project")
    expect(row.title).toBe("New session - 2026-04-04T10:31:44.822Z")
    expect(row.version).toBe("local")
    expect(row.time_created).toBe(1775298704822)
    expect(row.time_updated).toBe(1775298704822)
  })

  test("session.updated maps full session snapshot from bus info", () => {
    const row = session(sessionUpdated.properties.info)

    expect(row.id).toBe("ses_2a7f38a49ffeypaIAg9KzGPvn0")
    expect(row.title).toBe("Updated title")
    expect(row.share_url).toBe("https://share.example/session")
    expect(row.time_created).toBe(1775298704822)
    expect(row.time_updated).toBe(1775298704996)
  })

  test("message.updated maps nested time and model", () => {
    const row = message(messageUpdated.properties.info)

    expect(row.id).toBe("msg_d580c764f001G9t1LZZWDH5pVx")
    expect(row.session_id).toBe("ses_2a7f38a49ffeypaIAg9KzGPvn0")
    expect(row.role).toBe("user")
    expect(row.agent).toBe("Sisyphus (Ultraworker)")
    expect(row.model_provider_id).toBe("anthropic")
    expect(row.model_id).toBe("claude-opus-4-6")
    expect(row.time_created).toBe(1775298704975)
  })

  test("message.part.updated maps flat part fields", () => {
    const row = part(partUpdated.properties.part, partUpdated.properties.time)

    expect(row.id).toBe("prt_d580c7651001B2j8ZKav8eytrG")
    expect(row.message_id).toBe("msg_d580c764f001G9t1LZZWDH5pVx")
    expect(row.session_id).toBe("ses_2a7f38a49ffeypaIAg9KzGPvn0")
    expect(row.part_type).toBe("text")
    expect(row.text).toBe("phase55 one")
    expect(row.time_created).toBe(1775298704994)
  })

  test("session.created info without share still produces null share_url", () => {
    const row = session(sessionCreated.properties.info)
    expect(row.share_url).toBeNull()
  })

  test("message.part.updated part without tokens still produces null token fields", () => {
    const row = part(partUpdated.properties.part, partUpdated.properties.time)
    expect(row.input_tokens).toBeNull()
    expect(row.output_tokens).toBeNull()
    expect(row.cost).toBeNull()
  })
})

describe("routeBus", () => {
  test("routes session.created", () => {
    expect(routeBus(sessionCreated)).toEqual({
      type: "session.created",
      info: sessionCreated.properties.info,
    })
  })

  test("routes session.updated", () => {
    expect(routeBus(sessionUpdated)).toEqual({
      type: "session.updated",
      info: sessionUpdated.properties.info,
      sessionID: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
    })
  })

  test("routes session.deleted", () => {
    expect(routeBus(sessionDeleted)).toEqual({
      type: "session.deleted",
      sessionID: "ses_2a7f38a49ffeypaIAg9KzGPvn0",
    })
  })

  test("routes message.updated", () => {
    expect(routeBus(messageUpdated)).toEqual({
      type: "message.updated",
      info: messageUpdated.properties.info,
    })
  })

  test("routes message.removed", () => {
    expect(routeBus(messageRemoved)).toEqual({
      type: "message.removed",
      messageID: "msg_d580c764f001G9t1LZZWDH5pVx",
    })
  })

  test("routes message.part.updated", () => {
    expect(routeBus(partUpdated)).toEqual({
      type: "message.part.updated",
      part: partUpdated.properties.part,
      time: 1775298704994,
    })
  })

  test("routes message.part.removed", () => {
    expect(routeBus(partRemoved)).toEqual({
      type: "message.part.removed",
      partID: "prt_d580c7651001B2j8ZKav8eytrG",
    })
  })
})
