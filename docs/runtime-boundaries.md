# Runtime boundaries and bounded side effects

Monthly request usage is reserved atomically, up to the workspace request limit,
using UTC calendar months. Requests rejected for a platform quota do not increment
the counter or insert individual request-log rows. Unapproved scenario requests
also return without writing logs. Valid authenticated requests within quota may
still count when their route, request body or simulated behavior returns an error.

Webhook signatures use the delivery attempt's wall-clock timestamp, while the
payload retains the simulated event creation time. Each HTTPS connection has an
absolute ten-second deadline and a 64 KB response-byte ceiling. Stored response
excerpts remain limited to 4 KB. There are at most four connections per attempt,
with bounded five-second DNS resolution per connection. The 90-second worker
lease exceeds that maximum normal network budget.

Resetting or reconfiguring a session suppresses unfanned-out events and marks
pending or claimed deliveries failed with a session-reset reason. Already
started external HTTP requests cannot be recalled; an external receiver may
observe an in-flight request after reset. A cancelled worker claim cannot write
its completion back over the cancellation. Delivered event history is retained.

Simulation resources and generated response values use a saved seed and clock.
Webhook event IDs are currently random and delivery scheduling uses real wall
time, so reset does not reproduce byte-identical webhook traces. Controlled-clock
scheduling, delayed resource-state transitions and complete portable simulation
exports remain separate work.

The current contract compiler supports a bounded subset of OpenAPI 3.0/3.1 and
requires declared successful responses. Stateful execution validates JSON request
bodies and successful JSON resource responses. It does not yet implement general
path/query/header parameter schemas or serialization, imported security schemes,
OAuth, callbacks, response headers or arbitrary nested CRUD resource mappings.
The sandbox Bearer key controls sandbox access; it is not an implementation of the
imported API's authentication contract. Injected errors are explicit simulation
overrides rather than guaranteed declared OpenAPI error responses.
