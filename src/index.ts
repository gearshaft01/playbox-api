import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { tasksRouter } from "./endpoints/tasks/router";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { DummyEndpoint } from "./endpoints/dummyEndpoint";
import { cors } from "hono/cors";
import { Hono, type Context } from "hono";

type AppEnv = Env & {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  MODERATOR_USER_ID: string;
};

const app = new Hono<{ Bindings: AppEnv }>();

type VerifiedUser = {
  id: string;
  email: string | null;
};

type AuthResult =
  | { ok: true; user: VerifiedUser }
  | { ok: false; response: Response };

async function verifyUser(
  request: Request,
  env: AppEnv,
): Promise<AuthResult> {
  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return { ok: false, response: Response.json({ error: "Sign-in required" }, { status: 401 }) };
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    return { ok: false, response: Response.json({ error: "Authentication is not configured" }, { status: 503 }) };
  }

  const authResponse = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });

  if (authResponse.status === 401 || authResponse.status === 403) {
    return { ok: false, response: Response.json({ error: "Invalid or expired sign-in" }, { status: 401 }) };
  }
  if (!authResponse.ok) {
    return { ok: false, response: Response.json({ error: "Could not verify sign-in" }, { status: 502 }) };
  }

  const user: { id?: unknown; email?: unknown } = await authResponse.json();
  if (typeof user.id !== "string") {
    return { ok: false, response: Response.json({ error: "Invalid sign-in response" }, { status: 502 }) };
  }

  return {
    ok: true,
    user: { id: user.id, email: typeof user.email === "string" ? user.email : null },
  };
}

async function verifyModerator(request: Request, env: AppEnv): Promise<AuthResult> {
  const result = await verifyUser(request, env);
  if (!result.ok) return result;

  if (!env.MODERATOR_USER_ID) {
    return { ok: false, response: Response.json({ error: "Moderator is not configured" }, { status: 503 }) };
  }
  if (result.user.id !== env.MODERATOR_USER_ID) {
    return { ok: false, response: Response.json({ error: "Moderator access required" }, { status: 403 }) };
  }

  return result;
}

app.use("/api/*", cors({
  origin: "https://playbox.gearshaft01.workers.dev",
  allowMethods: ["GET", "OPTIONS", "POST"],
  allowHeaders: ["Content-Type", "Authorization",],
}));

app.onError((err, c) => {
	if (err instanceof ApiException) {
		// If it's a Chanfana ApiException, let Chanfana handle the response
		return c.json(
			{ success: false, errors: err.buildResponse() },
			err.status as ContentfulStatusCode,
		);
	}

	console.error("Global error handler caught:", err); // Log the error if it's not known

	// For other errors, return a generic 500 response
	return c.json(
		{
			success: false,
			errors: [{ code: 7000, message: "Internal Server Error" }],
		},
		500,
	);
});

// Setup OpenAPI registry
const openapi = fromHono(app, {
	docs_url: "/",
	schema: {
		info: {
			title: "My Awesome API",
			version: "2.0.0",
			description: "This is the documentation for my awesome API.",
		},
	},
});

// Register Tasks Sub router
openapi.route("/tasks", tasksRouter);

// Register other endpoints
openapi.post("/dummy/:slug", DummyEndpoint);

app.get("/api/games", async (c) => {
    const result = await c.env.DB.prepare(`
        SELECT
            g.id,
            g.owner_id AS author,
            v.version_number,
            v.title,
            v.description,
            v.color
        FROM games AS g
        JOIN game_versions AS v ON v.game_id = g.id
        WHERE v.status = 'approved'
            AND v.version_number = (
                SELECT MAX(latest.version_number)
                FROM game_versions AS latest
                WHERE latest.game_id = g.id
                    AND latest.status = 'approved'
            )
        ORDER BY v.created_at DESC
    `).all();

    return c.json({ games: result.results });
});

app.get("/api/games/:id", async (c) => {
  const game = await c.env.DB.prepare(`
    SELECT
      g.id,
      g.owner_id AS author,
      v.version_number,
      v.title,
      v.description,
      v.color,
      v.html,
      v.css,
      v.js
    FROM games AS g
    JOIN game_versions AS v ON v.game_id = g.id
    WHERE g.id = ?
      AND v.status = 'approved'
    ORDER BY v.version_number DESC
    LIMIT 1
  `).bind(c.req.param("id")).first();

  if (!game) {
    return c.json({ error: "Game not found" }, 404);
  }

  return c.json({ game });
});

app.get("/api/me", async (c) => {
  const authorization = c.req.header("Authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    return c.json({ error: "Sign-in required" }, 401);
  }

  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_PUBLISHABLE_KEY) {
    return c.json({ error: "Authentication is not configured" }, 503);
  }

  const authResponse = await fetch(
    `${c.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`,
    {
      headers: {
        apikey: c.env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (authResponse.status === 401 || authResponse.status === 403) {
    return c.json({ error: "Invalid or expired sign-in" }, 401);
  }

  if (!authResponse.ok) {
    return c.json({ error: "Could not verify sign-in" }, 502);
  }

  const user: { id?: unknown; email?: unknown } = await authResponse.json();

  if (typeof user.id !== "string") {
    return c.json({ error: "Invalid sign-in response" }, 502);
  }

  return c.json({
    user: {
      id: user.id,
      email: typeof user.email === "string" ? user.email : null,
    },
  });
});

app.post("/api/games", async (c) => {
  const token = c.req.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return c.json({ error: "Sign-in required" }, 401);

  const authResponse = await fetch(
    `${c.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`,
    {
      headers: {
        apikey: c.env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (authResponse.status === 401 || authResponse.status === 403) {
    return c.json({ error: "Invalid or expired sign-in" }, 401);
  }
  if (!authResponse.ok) {
    return c.json({ error: "Could not verify sign-in" }, 502);
  }

  const user: { id?: unknown } = await authResponse.json();
  if (typeof user.id !== "string") {
    return c.json({ error: "Invalid sign-in response" }, 502);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid game data" }, 400);
  }

  const game = body as Record<string, unknown>;
  const fields = ["title", "description", "color", "html", "css", "js"];
  if (fields.some((field) => typeof game[field] !== "string")) {
    return c.json({ error: "All game fields must be strings" }, 400);
  }

  const title = game.title as string;
  const description = game.description as string;
  const color = game.color as string;
  const html = game.html as string;
  const css = game.css as string;
  const js = game.js as string;

  if (!title.trim() || title.length > 100) {
    return c.json({ error: "Title is required and must be at most 100 characters" }, 400);
  }
  if (description.length > 500) {
    return c.json({ error: "Description must be at most 500 characters" }, 400);
  }
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    return c.json({ error: "Invalid thumbnail color" }, 400);
  }
  if (new TextEncoder().encode(html + css + js).length > 1_800_000) {
    return c.json({ error: "Game code is too large for D1 storage" }, 413);
  }

  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO games (id, owner_id) VALUES (?, ?)"
    ).bind(id, user.id),
    c.env.DB.prepare(`
      INSERT INTO game_versions (
        game_id, version_number, status, title, description, color, html, css, js
      ) VALUES (?, 1, 'pending', ?, ?, ?, ?, ?, ?)
    `).bind(id, title.trim(), description, color, html, css, js),
  ]);

  return c.json({ id, status: "pending" }, 201);
});

app.get("/api/moderation/pending", async (c) => {
  const auth = await verifyModerator(c.req.raw, c.env);
  if (!auth.ok) return auth.response;

  const result = await c.env.DB.prepare(`
    SELECT
      g.id AS game_id,
      g.owner_id AS author,
      v.version_number,
      v.title,
      v.description,
      v.color,
      v.html,
      v.css,
      v.js
    FROM game_versions AS v
    JOIN games AS g ON g.id = v.game_id
    WHERE v.status = 'pending'
    ORDER BY v.created_at ASC
  `).all();

  return c.json({ games: result.results });
});

app.post("/api/moderation/games/:id/versions/:versionNumber", async (c) => {
  const auth = await verifyModerator(c.req.raw, c.env);
  if (!auth.ok) return auth.response;

  const versionNumber = Number(c.req.param("versionNumber"));
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
    return c.json({ error: "Invalid version number" }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid review decision" }, 400);
  }

  const decision = body as Record<string, unknown>;
  if (decision.status !== "approved" && decision.status !== "rejected") {
    return c.json({ error: "Status must be approved or rejected" }, 400);
  }

  const reason = typeof decision.reason === "string" ? decision.reason.trim() : "";
  if (decision.status === "rejected" && !reason) {
    return c.json({ error: "A reason is required to reject a game" }, 400);
  }
  if (reason.length > 500) {
    return c.json({ error: "Reason must be at most 500 characters" }, 400);
  }

  const result = await c.env.DB.prepare(`
    UPDATE game_versions
    SET status = ?, review_reason = ?
    WHERE game_id = ? AND version_number = ? AND status = 'pending'
  `).bind(
    decision.status,
    decision.status === "rejected" ? reason : "",
    c.req.param("id"),
    versionNumber,
  ).run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Pending game version not found" }, 404);
  }

  return c.json({ success: true });
});

// Export the Hono app
export default app;
