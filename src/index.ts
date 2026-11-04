import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { tasksRouter } from "./endpoints/tasks/router";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { DummyEndpoint } from "./endpoints/dummyEndpoint";

// Start a Hono app
const app = new Hono<{ Bindings: Env }>();

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

// Export the Hono app
export default app;
