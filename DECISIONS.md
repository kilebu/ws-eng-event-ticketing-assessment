# Engineering Decisions

## Problem Understanding

I'm building two features for the event ticketing platform:

1. **Ticket Transfer** (Tests 1-6) — Attendees transfer CONFIRMED bookings to other registered users immediately, with the original owner losing access and recipient gaining full ownership.

2. **Event Waitlist** (Tests 7-10) — Attendees join a waitlist for sold-out events, automatically receiving a confirmed ticket when someone cancels (via atomic transaction).

**Key Challenges:**

- Maintaining data integrity during transfers: The codebase already has a `transfer.ts` utility using cancel+create pattern (cancel original with zero refund, create new booking with fresh ticket codes). Must integrate this atomically.
- Race conditions on waitlist promotion: Multiple concurrent cancellations could try to promote the same waitlist user. Must use transaction isolation and unique constraints.
- Concurrent capacity tracking: Both event-level and tier-level sold counts must stay consistent. The codebase has `capacity.ts` helpers (`incrementCapacity()`, `decrementCapacity()`) that handle both atomically.
- Event sold-out detection with tiers: Logic differs for tiered vs non-tiered events; must check all tiers vs event capacity.

**Key Findings from Code Review:**

- `transfer.ts` is production-ready; just needs endpoint wrapper with recipient validation
- Cancellation transaction (in `bookings.ts` DELETE) already validates, calculates refund, updates status, and restores promo usage—waitlist check inserts here
- Seed data: Event 10 (Chef's Table) has capacity=2, pre-booked by alice+bob = ready-made sold-out event for tests
- QR system uses JSON format `{code, ts}`; regenerates on transfer

## Approach

**Ticket Transfer (Story 1):**

- Reuse existing `transfer.ts` utility (cancel+create pattern is production-ready)
- Add `POST /api/bookings/:bookingId/transfer` endpoint with recipient email validation
- Validates: booking exists, belongs to user, status=CONFIRMED, recipient exists, recipient≠user
- Uses `prisma.$transaction(transferBooking())` for atomicity
- Frontend: "Transfer Ticket" button on ticket page opens modal, accepts recipient email, redirects to bookings on success

**Event Waitlist (Story 2):**

- Create `WaitlistEntry` model with `@@unique([userId, eventId, status])` to prevent duplicates and `@@index([eventId, status, joinedAt])` for efficient FIFO
- Three endpoints:
  - `POST /api/events/:eventId/waitlist` — Join (validates not already booked, idempotent)
  - `GET /api/events/:eventId/waitlist/position` — Check position via count query
  - `DELETE /api/events/:eventId/waitlist` — Leave (soft-delete: status→LEFT)
- Insert promotion logic into cancellation transaction after `decrementCapacity()`:
  - Find oldest WAITING entry for event
  - Check if event still sold out (all tiers at capacity or event.soldCount >= event.capacity)
  - Create CONFIRMED booking for promoted user with fresh ticket codes
  - Mark entry status→PROMOTED, call `incrementCapacity()`
- Frontend: Replace "Buy Ticket" with "Join Waitlist" when sold out; show position in sidebar; add leave button on bookings page

**Why this approach:**

- Cancel+create is proven in codebase (organizer reassignment uses it) and provides clean audit trail
- Atomic transaction prevents race conditions on concurrent cancellations
- Soft-delete preserves waitlist history
- Reuses existing `capacity.ts` and error handling patterns
- Separate WaitlistEntry model avoids confusion and keeps schema clear

## Risks & Assumptions

**Risks and Mitigations:**

- **Race condition on waitlist promotion:** Multiple concurrent cancellations could promote same user. Mitigated by Prisma's `$transaction` isolation level and `@@unique` constraint preventing duplicate bookings.
- **Sold-out check before tier query:** Avoid checking tiers separately. Mitigation: fetch event+tiers in one query.
- **QR code collision on transfer:** Unlikely with 32-byte random ticket code; monitor in logs.
- **Capacity count corruption:** Could increment/decrement twice. Mitigation: clear code structure—decrement in cancel, increment in promotion.
- **Waitlist position performance:** Scales with event waitlist size (acceptable for expected scale; add INDEX for optimization).

**Assumptions:**

- Transferred tickets inherit original price (no repricing)
- Waitlist join is idempotent (joining twice returns current position, doesn't error)
- Promoted bookings don't send notifications (requirement silent on this)
- Waitlist position is dynamic (recalculated on each view)
- Transfers do NOT open waitlist slots (only cancellations do)
- Recipient email validation uses exact User.email match

**Questions for Product Manager:**

- Should promoted tickets retain original tier or accept any available tier if original is unavailable?
- Is there a time limit for claiming a promoted ticket?
- Should cancelled bookings that were previously transferred still trigger waitlist promotion? (Assuming yes—ticket is released either way)

## Implementation Sequence

**Order of work (front-to-back architecture):**

1. **Prisma schema update** (10 min) — Add WaitlistEntry model with relations and indexes; run `prisma db push`
2. **Waitlist backend** (50 min) — Implement POST/GET/DELETE endpoints in `waitlist.ts` with FIFO logic and validation
3. **Cancellation integration** (40 min) — Modify `bookings.ts` DELETE handler to insert waitlist promotion logic into transaction
4. **Transfer endpoint** (20 min) — Add `POST /api/bookings/:id/transfer` with recipient validation; use existing `transferBooking()` utility
5. **API client methods** (20 min) — Add `waitlistAPI` and `bookingsAPI.transfer()` methods to `frontend/src/lib/api.ts`
6. **Transfer UI** (30 min) — Add "Transfer Ticket" button and modal on `/tickets/[id]/page.tsx`
7. **Waitlist UI** (40 min) — Update `/events/[id]/page.tsx` (show "Join Waitlist" when sold out) and `/bookings/page.tsx` (show waitlist entries and position)
8. **Manual testing** (30 min) — Execute all 10 acceptance tests; capture screenshots; test with seed data Event 10 (pre-sold-out)

**Total time: ~240 min (4 hours) — achieves 2-star completeness target**

**Success criteria:**

- All 10 acceptance tests pass with screenshots
- Transfer: Old owner loses access, new owner sees transferred ticket with valid QR code
- Waitlist: Promoted user automatically receives confirmed ticket in same transaction as cancellation
- No soldCount corruption; data remains consistent across tiers and events
- Code follows existing patterns; reuses `capacity.ts`, `transfer.ts`, error handling conventions
