# MVP v1 Contract

Resolve supports `person` and `company` records. External JSON uses snake_case.

## Record envelope

```json
{
  "source": "crm",
  "external_id": "contact_9234",
  "entity_type": "person",
  "data": {
    "name": "Abdulkerim Hassen",
    "email": "abdul@example.com",
    "phone": "0911223344"
  }
}
```

Person data may contain `name`, `email`, `phone`, `company`, `company_domain`, `address`, and `attributes`. At least one of `name`, `email`, or `phone` must contain text.

Company data may contain `name`, `domain`, `email`, `phone`, `registration_id`, `address`, and `attributes`. At least one identity field must contain text.

Addresses may contain `line1`, `line2`, `city`, `region`, `postal_code`, and a two-letter `country` code.

## Resolution result

```json
{
  "record_id": "rec_01JEXAMPLE",
  "entity_id": "ent_01JEXAMPLE",
  "decision": "AUTO_MATCH",
  "confidence": 0.963,
  "matched_against": "ent_01JEXISTING",
  "explanation": {
    "features": {
      "email_exact": true,
      "phone_exact": true,
      "name_similarity": 0.944
    },
    "contradictions": [],
    "candidate_count": 7
  },
  "algorithm_version": "rules-0.1.0",
  "created_at": "2026-09-06T10:00:00.000Z"
}
```

Decisions are `AUTO_MATCH`, `REVIEW`, or `NO_MATCH`. Confidence stays between 0 and 1. Every result includes structured evidence and an algorithm version.
