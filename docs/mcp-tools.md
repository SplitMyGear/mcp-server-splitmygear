# Splitt MCP Server - Tool Reference

This document describes all available MCP tools and their parameters.

## Listing & Recommendation Tools

### 1. search_listings
Search for available listings with various filters or natural language.
- **Arguments**: `location`, `checkIn`, `checkOut`, `guests`, `category`, `minPrice`, `maxPrice`, `query` (natural language).

### 2. get_listing_details
Get detailed information about a specific listing.
- **Arguments**: `listingId`.

### 3. check_availability
Check if a listing is available for specific dates.
- **Arguments**: `listingId`, `checkIn`, `checkOut`, `guests`.

### 4. get_similar_listings
Find similar listings based on category and semantic similarity.
- **Arguments**: `listingId`, `limit` (default: 5).

### 5. get_personalized_recommendations
Get gear suggestions based on user booking history.
- **Arguments**: `userId`, `limit` (default: 5).

---

## Booking Tools

### 6. create_booking
Create a new booking with Stripe payment.
- **Arguments**: `listingId`, `checkIn`, `checkOut`, `guests`, `userId`.

### 7. cancel_booking
Cancel an existing booking.
- **Arguments**: `bookingId`, `userId`, `reason`.

### 8. get_booking_status
Get the status of a booking.
- **Arguments**: `bookingId`.

---

## AI Features & Pricing

### 9. suggest_listing_price
Analyze market data to suggest a competitive price.
- **Arguments**: `category`, `location` (optional).

### 10. analyze_competitor_pricing
Compare a specific listing against local competitors.
- **Arguments**: `listingId`.

### 11. generate_listing_description
Create a professional description from keywords.
- **Arguments**: `name`, `category`, `keywords` (string array).

### 12. improve_listing_title
Optimize a title for SEO and click-through rate.
- **Arguments**: `currentTitle`.

---

## Experiences

### 13. search_experiences
Browse outdoor adventures and tours.
- **Arguments**: `location`, `category`.

### 14. get_experience_details
Get full info and available schedules for an experience.
- **Arguments**: `experienceId`.

### 15. book_experience
Book spots on a specific experience schedule.
- **Arguments**: `scheduleId`, `userId`, `guests`.

---

## Messaging

### 16. send_message
Send a message to another user (renter/vendor).
- **Arguments**: `senderId`, `recipientId`, `content`, `conversationId` (optional).

### 17. get_conversations
List all active chat threads for a user.
- **Arguments**: `userId`.

### 18. generate_ai_message_draft
Draft a professional response using AI.
- **Arguments**: `context`, `userRole` ('renter' | 'vendor'), `tone` (optional).

---

## Resources

### listing-categories
Returns a list of available listing categories.
**URI**: `splitmygear://categories`

---

## Error Codes
| Code | Description |
|------|-------------|
| -32600 | Invalid Request |
| -32601 | Method not found |
| 401 | Unauthorized |
| 429 | Rate limit exceeded |
| 500 | Internal Server Error |
