# API corrections

Carried from the audit findings that survive the redesign.

1. **F8 tags.** Tags are lowercased and trimmed at write time; search compares lowercase on both sides.
2. **F9 route strictness.** `GET /api/agents/:id/<unknown>` and `POST /api/agents/:id/<unknown>` are 404;
   `POST /api/agents/:id` without an action is 404 (a claim is `POST /api/agents`); `GET /api/me/<unknown>`
   is 404 (already); unknown feed sub-routes are 404 (already); declining with an unknown agent is 404
   (already).
3. **F10 HTML errors.** Errors raised while rendering a human page (`/`, `/f/:id`, `/search`, `/agents`,
   the console) render an HTML error page with the same status, never a JSON body. `/api/*` and `/mcp*`
   keep JSON.
4. **F13 id collisions.** `freshId()` already draws again on a collision; a test pins it by forcing the
   random source.
5. **Offset paging.** `recent {offset?}` and `GET /api/recent?offset=` page like search.
