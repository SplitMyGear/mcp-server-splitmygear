# What each MCP tool can do on the backend

SPLIT-1207. The table below is generated from the tool registry, and `__tests__/tool-authority.test.ts` fails if it drifts.

## The model

The server holds no database, payment or LLM client, and no backend service credential. A tool's authority on the backend is the authority of the token it is handed, and the backend re-checks authentication, role and ownership on every call.

| Principal | Backend token | Reaches |
| --- | --- | --- |
| Operator key (`x-api-key`) | None. Reports role `admin`, but that role is never sent to the backend. | `public` tools in the `read` scope. Calls are anonymous on the backend. |
| OAuth connection (`smg_at.…`) | The user's backend JWT, sealed in the access token. | Tools for the user's role, limited to the scopes they granted. A `public` tool forwards the JWT only with the matching resource scope (see below). |
| Raw backend JWT (`Authorization: Bearer`) | The caller's JWT, verified first (`src/lib/jwt.ts`). | Tools for the user's role, in every scope. |

**Server secrets, none usable by a tool:**
- `MCP_OAUTH_SIGNING_KEY` seals OAuth tokens and client records.
- `MCP_BFF_RELAY_KEY` is sent only by the OAuth login bridge (`src/lib/oauth/backend-auth.ts`), so the backend's login throttle keys on the end user's IP. It grants no user authority.
- `MCP_BACKEND_JWT_SECRET`, when set, verifies raw bearers in-process.
- `MCP_API_KEY` authenticates the operator.

No file under `src/tools` reads the environment; a test enforces this.

## Access levels

| Access | Who | Check |
| --- | --- | --- |
| `public` | Any authenticated principal | None beyond authentication |
| `user` | Any signed-in user | Backend token present |
| `renter` | Renter and admin | `canBookRentals` |
| `vendor` | Vendor family and admin | `canActAsVendor` |
| `vendor_finance` | Owner and admin | `canViewVendorFinance` |
| `vendor_owner` | Owner and admin | `canManageVendorPayouts` |

**Owner view on public tools (SPLIT-1887).** A few `public` tools read a resource the backend shows differently to its owner (tax address, unpublished state, moderation). They take the token from `ownerViewToken(ctx, scope)` in `src/tools/registry.ts`, never from `ctx.token`: `get_listing_details` and `list_listing_routes` forward it only with `listings`, `get_experience_details` only with `experiences`. Otherwise the call is anonymous. A test fails if a public tool reads `ctx.token` directly.

These checks decide what is listed and callable. They are not the security boundary: the backend decides every forwarded call.

**Effect** comes from each tool's MCP annotations, which are hints to the assistant rather than enforcement.

## Tools

<!-- generated: tool table -->

| Tool | Access | Scope | Effect |
| --- | --- | --- | --- |
| `accept_terms` | user | profile | write |
| `add_blackout_dates` | vendor | listings | write |
| `add_calendar_feed` | vendor | listings | write |
| `add_claim_evidence` | user | claims | write |
| `add_experience_schedule` | vendor | experiences | write |
| `add_fleet_units` | vendor | listings | write |
| `add_gear_guide_note` | vendor | listings | write |
| `add_insurance_policy` | vendor | listings | write |
| `analyze_competitor_pricing` | public | read | read |
| `answer_gear_guide_gap` | vendor | listings | write |
| `apply_dynamic_pricing` | vendor | listings | write (destructive) |
| `apply_starter_seasons` | vendor | listings | write |
| `apply_to_become_vendor` | user | profile | write |
| `archive_listing` | vendor | listings | write |
| `ask_gear_guide` | user | bookings | write |
| `attach_route_to_listing` | vendor | listings | write |
| `book_experience` | user | bookings | write |
| `book_service` | user | bookings | write |
| `cancel_booking` | user | bookings | write (destructive) |
| `cancel_experience_booking` | user | bookings | write (destructive) |
| `cancel_incidental_charge` | vendor | claims | write (destructive) |
| `cancel_service_booking` | user | bookings | write (destructive) |
| `check_availability` | public | read | read |
| `check_vendor_stripe_status` | user | profile | read |
| `clear_feed_suppression` | vendor | listings | write |
| `complete_vendor_business_profile` | user | profile | write |
| `confirm_vendor_stripe` | user | profile | write |
| `create_booking` | renter | bookings | write |
| `create_experience` | vendor | experiences | write |
| `create_handoff_token` | user | bookings | write |
| `create_listing` | vendor | listings | write |
| `create_listing_route` | vendor | listings | write |
| `create_message_template` | vendor | messaging | write |
| `create_rate_rule` | vendor | listings | write |
| `create_review` | user | reviews | write |
| `create_route` | vendor | listings | write |
| `create_search_alert` | user | favorites | write |
| `create_service` | vendor | listings | write |
| `create_waiver` | vendor | listings | write |
| `delete_experience` | vendor | experiences | write (destructive) |
| `delete_experience_schedule` | vendor | experiences | write (destructive) |
| `delete_fleet_unit` | vendor | listings | write (destructive) |
| `delete_insurance_policy` | vendor | listings | write (destructive) |
| `delete_listing` | vendor | listings | write (destructive) |
| `delete_listing_route` | vendor | listings | write (destructive) |
| `delete_message_template` | vendor | messaging | write (destructive) |
| `delete_rate_rule` | vendor | listings | write (destructive) |
| `delete_review` | user | reviews | write (destructive) |
| `delete_route` | vendor | listings | write (destructive) |
| `delete_saved_trip` | user | favorites | write (destructive) |
| `delete_search_alert` | user | favorites | write (destructive) |
| `delete_service` | vendor | listings | write (destructive) |
| `delete_waiver` | vendor | listings | write (destructive) |
| `detach_route_from_listing` | vendor | listings | write (destructive) |
| `duplicate_listing` | vendor | listings | write |
| `email_trip_plan` | user | favorites | write |
| `export_my_data` | user | profile | read |
| `file_damage_claim` | vendor | claims | write (destructive) |
| `file_incidental_charge` | vendor | claims | write (destructive) |
| `gear_guide_status` | vendor | listings | read |
| `generate_ai_message_draft` | user | messaging | read |
| `generate_ai_trip_plan` | public | read | read |
| `generate_care_guide` | vendor | listings | write |
| `generate_dynamic_pricing_recommendations` | vendor | listings | write |
| `generate_listing_description` | user | listings | read |
| `generate_listing_draft` | vendor | listings | read |
| `get_booking_history` | user | bookings | read |
| `get_booking_quote` | public | read | read |
| `get_booking_risk` | vendor | vendor_bookings | read |
| `get_booking_status` | user | bookings | read |
| `get_booking_verification` | user | bookings | read |
| `get_calendar_subscription_url` | vendor | listings | write |
| `get_category` | public | read | read |
| `get_claim` | user | claims | read |
| `get_conversation_messages` | user | messaging | read |
| `get_conversations` | user | messaging | read |
| `get_destination` | public | read | read |
| `get_dispute` | user | claims | read |
| `get_dynamic_pricing_config` | vendor | listings | read |
| `get_dynamic_pricing_recommendations` | vendor | listings | read |
| `get_email_preferences` | user | profile | read |
| `get_experience_booking` | user | bookings | read |
| `get_experience_details` | public | read | read |
| `get_fleet_summary` | vendor | listings | read |
| `get_identity_verification_status` | user | profile | read |
| `get_incidental_charge` | user | claims | read |
| `get_inspection_checklist_template` | user | bookings | read |
| `get_inspection_completion` | user | bookings | read |
| `get_insurance_document_link` | vendor | listings | read |
| `get_listing_calendar` | public | read | read |
| `get_listing_details` | public | read | read |
| `get_listing_ical_export_url` | vendor | listings | read |
| `get_listing_performance` | vendor | listings | read |
| `get_listing_reviews` | public | read | read |
| `get_market_insights` | vendor | listings | read |
| `get_message_template` | vendor | messaging | read |
| `get_my_profile` | user | profile | read |
| `get_my_trust_score` | user | profile | read |
| `get_notification_preferences` | user | profile | read |
| `get_payment_link` | renter | bookings | write |
| `get_payout_details` | vendor_finance | finance | read |
| `get_personalized_recommendations` | user | profile | read |
| `get_public_route` | public | read | read |
| `get_report_subscription` | vendor | finance | read |
| `get_required_waivers` | user | bookings | read |
| `get_route` | vendor | listings | read |
| `get_security_status` | user | profile | read |
| `get_service_booking` | user | bookings | read |
| `get_service_details` | public | read | read |
| `get_similar_listings` | public | read | read |
| `get_stripe_connect_status` | vendor_finance | finance | read |
| `get_suggested_initial_price` | vendor | listings | read |
| `get_tax_summary` | vendor | finance | read |
| `get_terms_status` | user | profile | read |
| `get_transaction` | user | finance | read |
| `get_trip_ideas_for_listing` | public | read | read |
| `get_trip_pois` | public | read | read |
| `get_unit_maintenance_history` | vendor | listings | read |
| `get_unit_stats` | vendor | listings | read |
| `get_unread_counts` | user | profile | read |
| `get_vendor_agreement` | user | profile | read |
| `get_vendor_dashboard` | vendor | finance | read |
| `get_vendor_earnings` | vendor_finance | finance | read |
| `get_vendor_onboarding_status` | user | profile | read |
| `get_vendor_payouts` | vendor_finance | finance | read |
| `import_gpx_route` | vendor | listings | write |
| `improve_listing_title` | user | listings | read |
| `list_blackout_dates` | vendor | listings | read |
| `list_calendar_feeds` | vendor | listings | read |
| `list_categories` | public | read | read |
| `list_claims` | user | claims | read |
| `list_destinations` | public | read | read |
| `list_disputes` | user | claims | read |
| `list_experience_host_bookings` | vendor | experiences | read |
| `list_favorites` | user | favorites | read |
| `list_fleet_units` | vendor | listings | read |
| `list_gear_guide_gaps` | vendor | listings | read |
| `list_gear_guide_topics` | user | bookings | read |
| `list_incidental_charges` | user | claims | read |
| `list_incoming_bookings` | vendor | vendor_bookings | read |
| `list_listing_promotions` | vendor | finance | read |
| `list_listing_routes` | public | read | read |
| `list_message_templates` | vendor | messaging | read |
| `list_my_bookings` | user | bookings | read |
| `list_my_experience_bookings` | user | bookings | read |
| `list_my_experiences` | vendor | experiences | read |
| `list_my_insurance_policies` | vendor | listings | read |
| `list_my_listings` | vendor | listings | read |
| `list_my_reviews` | user | reviews | read |
| `list_my_routes` | vendor | listings | read |
| `list_my_service_bookings` | user | bookings | read |
| `list_my_services` | vendor | listings | read |
| `list_my_transactions` | user | finance | read |
| `list_my_waivers` | vendor | listings | read |
| `list_notifications` | user | profile | read |
| `list_rate_rules` | vendor | listings | read |
| `list_saved_trips` | user | favorites | read |
| `list_search_alerts` | user | favorites | read |
| `list_signed_waivers` | user | bookings | read |
| `list_sponsorship_packages` | vendor | finance | read |
| `log_unit_maintenance` | vendor | listings | write |
| `mark_conversation_read` | user | messaging | write |
| `mark_notifications_read` | user | profile | write |
| `open_dispute` | user | claims | write (destructive) |
| `plan_trip` | public | read | read |
| `preview_cancellation` | user | bookings | read |
| `preview_dynamic_price` | vendor | listings | read |
| `promote_listing` | vendor | finance | write |
| `propose_booking_reschedule` | vendor | vendor_bookings | write |
| `refresh_my_trust_score` | user | profile | write |
| `remove_blackout_date` | vendor | listings | write (destructive) |
| `remove_calendar_feed` | vendor | listings | write (destructive) |
| `request_payout` | vendor_owner | finance | write (destructive) |
| `resend_verification_email` | user | profile | write |
| `respond_to_claim` | user | claims | write (destructive) |
| `respond_to_incidental_charge` | user | claims | write (destructive) |
| `respond_to_reschedule_proposal` | user | bookings | write (destructive) |
| `respond_to_review` | vendor | reviews | write |
| `review_service` | user | reviews | write |
| `rotate_calendar_subscription_url` | vendor | listings | write (destructive) |
| `save_trip` | user | favorites | write |
| `search_experiences` | public | read | read |
| `search_listings` | public | read | read |
| `search_services` | public | read | read |
| `send_message` | user | messaging | write |
| `set_auto_approve` | vendor | vendor_bookings | write |
| `set_booking_protection` | user | bookings | write |
| `set_booking_return_status` | vendor | vendor_bookings | write |
| `set_booking_vendor_notes` | vendor | vendor_bookings | write |
| `set_dynamic_pricing_config` | vendor | listings | write |
| `set_email_preferences` | user | profile | write |
| `set_experience_status` | vendor | experiences | write |
| `set_listing_published` | vendor | listings | write |
| `set_listing_routes` | vendor | listings | write |
| `set_notification_preference` | user | profile | write |
| `set_report_subscription` | vendor | finance | write |
| `sign_out_all_sessions` | user | profile | write (destructive) |
| `sign_vendor_agreement` | user | profile | write |
| `sign_waiver` | user | bookings | write |
| `start_stripe_connect_onboarding` | vendor_owner | finance | write |
| `start_vendor_onboarding` | user | profile | write |
| `start_vendor_stripe_onboarding` | user | profile | write |
| `submit_inspection_checklist` | user | bookings | write |
| `suggest_listing_price` | public | read | read |
| `suggest_locations` | public | read | read |
| `sync_calendar_feed` | vendor | listings | write |
| `toggle_favorite` | user | favorites | write |
| `toggle_search_alert` | user | favorites | write |
| `update_calendar_feed` | vendor | listings | write |
| `update_experience` | vendor | experiences | write |
| `update_experience_booking_status` | vendor | experiences | write |
| `update_fleet_unit` | vendor | listings | write |
| `update_insurance_policy` | vendor | listings | write |
| `update_listing` | vendor | listings | write |
| `update_listing_route` | vendor | listings | write |
| `update_message_template` | vendor | messaging | write |
| `update_my_profile` | user | profile | write |
| `update_rate_rule` | vendor | listings | write |
| `update_review` | user | reviews | write |
| `update_route` | vendor | listings | write |
| `update_search_alert` | user | favorites | write |
| `update_service` | vendor | listings | write |
| `update_service_booking_status` | vendor | vendor_bookings | write |
| `update_waiver` | vendor | listings | write |
| `upload_file` | user | files | write |
| `upload_gear_manual` | vendor | listings | read |
| `upload_handoff_photos` | user | bookings | write |
| `verify_handoff_token` | user | bookings | write |
| `withdraw_reschedule_proposal` | vendor | vendor_bookings | write |
