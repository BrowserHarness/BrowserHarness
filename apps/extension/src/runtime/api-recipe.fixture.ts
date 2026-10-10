// A contract the Bridge learned from the local fixture shop (apps/bridge/test/
// fixtures), with its origin renamed to shop.example. Test data only.
import type { ApiOperationContract } from "./api-recipe";

export function searchContract(): ApiOperationContract {
  return {
    "contract_version": 2,
    "operation_id": "op-e7562f40fbcdce1c",
    "name": "search",
    "origin": "https://shop.example",
    "side_effect": "read",
    "side_effect_basis": "GET without an action-looking path",
    "request": {
      "method": "GET",
      "url": "https://shop.example/api/search?q=laptops&page=1&lang=en",
      "headers": {
        "user-agent": "Mozilla/5.0 fixture",
        "accept": "application/json",
        "referer": "https://shop.example/search?q=laptops"
      }
    },
    "slots": [
      {
        "param": "q",
        "at": [
          "query:q"
        ]
      },
      {
        "param": "q",
        "at": [
          "header:referer"
        ],
        "template": "https://shop.example/search?q={q}"
      }
    ],
    "volatile": [],
    "params": [
      {
        "name": "q",
        "type": "string",
        "required": true,
        "example": "laptops"
      }
    ],
    "session_refs": [],
    "session_sources": [],
    "response": {
      "format": "json",
      "contentType": "application/json; charset=utf-8",
      "extract": "items",
      "shape": {
        "items": "array",
        "items[]": "object",
        "items[].id": "string",
        "items[].title": "string",
        "items[].price": "number",
        "page": "number",
        "took_ms": "number"
      }
    },
    "match": {
      "method": "GET",
      "host": "shop.example",
      "path": "/api/search"
    },
    "trigger": {
      "url": "https://shop.example/search?q={q}"
    },
    "min_tier": 1,
    "learned_logged_in": false,
    "transport": {
      "preference": [
        1,
        2,
        3
      ],
      "learned_tier": 1
    },
    "verification": {
      "status": "verified",
      "checks": [
        {
          "kind": "learned_examples",
          "passed": true,
          "class": "ok",
          "arg_names": [
            "q"
          ],
          "item_count": 2,
          "checked_at": "2026-10-10T06:36:26.681Z"
        },
        {
          "kind": "learned_examples",
          "passed": true,
          "class": "ok",
          "arg_names": [
            "q"
          ],
          "item_count": 2,
          "checked_at": "2026-10-10T06:36:26.681Z"
        },
        {
          "kind": "unseen_input",
          "passed": true,
          "tier": 1,
          "class": "ok",
          "arg_names": [
            "q"
          ],
          "item_count": 2,
          "checked_at": "2026-10-10T06:36:26.681Z"
        }
      ]
    },
    "provenance": {
      "source": "two_example_learning",
      "engine": "browserharness-api-engine/1 (api-anything@fe5cca7)",
      "learned_at": "2026-10-10T06:36:26.669Z",
      "evidence_ids": [
        "api-fixture"
      ],
      "warnings": []
    }
  } as ApiOperationContract;
}
