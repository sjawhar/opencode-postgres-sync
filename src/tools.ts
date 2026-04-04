import { tool } from "@opencode-ai/plugin"
import type { Db } from "./schema.js"

const periods: Record<string, string> = {
  day: "1 day",
  week: "7 days",
  month: "30 days",
}

export function tools(sql: Db) {
  return {
    "search-sessions": tool({
      description:
        "Search sessions across all machines in the fleet. Matches session titles and message content via full-text search.",
      args: {
        query: tool.schema.string().describe("Search query — matches session titles and message content"),
        limit: tool.schema.number().optional().describe("Max results (default 20)"),
      },
      async execute(args) {
        const cap = args.limit ?? 20
        try {
          const rows = await sql<
            {
              id: string
              title: string
              machine: string
              excerpt: string
              time: string
            }[]
          >`
            SELECT DISTINCT ON (s.id)
              s.id,
              s.title,
              COALESCE(s.origin_machine, 'unknown') as machine,
              COALESCE(
                left(p.text, 200),
                left(s.title, 200)
              ) as excerpt,
              to_timestamp(s.time_created / 1000.0)::text as time
            FROM session s
            LEFT JOIN part p ON p.session_id = s.id
            WHERE
              s.title ILIKE ${"%" + args.query + "%"}
              OR (
                p.text IS NOT NULL
                AND to_tsvector('english', p.text) @@ plainto_tsquery('english', ${args.query})
              )
            ORDER BY s.id, s.time_created DESC
            LIMIT ${cap}
          `
          if (!rows.length) return "No sessions found matching: " + args.query
          return JSON.stringify(rows, null, 2)
        } catch (err) {
          return "Search failed: " + (err as Error).message
        }
      },
    }),

    analytics: tool({
      description: "Get token and cost analytics across all fleet sessions. Aggregates from the token_usage view.",
      args: {
        period: tool.schema.string().optional().describe("Time period: 'day', 'week', 'month', 'all' (default 'week')"),
        model: tool.schema.string().optional().describe("Filter by model ID"),
      },
      async execute(args) {
        const interval = periods[args.period ?? "week"]
        try {
          const rows = await sql<
            {
              model: string
              input_tokens: string
              output_tokens: string
              total_cost: string
              sessions: string
            }[]
          >`
            SELECT
              model,
              SUM(input_tokens)::text as input_tokens,
              SUM(output_tokens)::text as output_tokens,
              SUM(total_cost)::text as total_cost,
              SUM(sessions)::text as sessions
            FROM token_usage
            WHERE
              (${interval}::text IS NULL OR day >= NOW() - ${interval ?? "7 days"}::interval)
              AND (${args.model ?? null}::text IS NULL OR model = ${args.model ?? ""})
            GROUP BY model
            ORDER BY SUM(total_cost) DESC NULLS LAST
          `
          if (!rows.length) return "No analytics data for the given period."
          return JSON.stringify(rows, null, 2)
        } catch (err) {
          return "Analytics query failed: " + (err as Error).message
        }
      },
    }),

    "replication-status": tool({
      description: "Check replication health across the fleet. Shows lag, event counts, and status per machine.",
      args: {},
      async execute() {
        try {
          const rows = await sql<
            {
              machine: string
              lag_seconds: string
              events_replicated: string
              last_update: string
              status: string
            }[]
          >`
            SELECT
              source_machine as machine,
              EXTRACT(EPOCH FROM (NOW() - MAX(updated_at)))::int::text as lag_seconds,
              COUNT(*)::text as events_replicated,
              MAX(updated_at)::text as last_update,
              CASE
                WHEN EXTRACT(EPOCH FROM (NOW() - MAX(updated_at))) < 300 THEN 'healthy'
                WHEN EXTRACT(EPOCH FROM (NOW() - MAX(updated_at))) < 3600 THEN 'stale'
                ELSE 'offline'
              END as status
            FROM replication_state
            GROUP BY source_machine
            ORDER BY MAX(updated_at) DESC
          `
          if (!rows.length) return "No replication data found."
          return JSON.stringify(rows, null, 2)
        } catch (err) {
          return "Replication status check failed: " + (err as Error).message
        }
      },
    }),
  }
}
