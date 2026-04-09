# Prompt Library API Schema

This schema is designed for connecting Prompt Library to your backend API.

## 1) Entities

### Category
```json
{
  "id": "coding-help",
  "slug": "coding-help",
  "title": "Coding Help",
  "description": "Understand code, fix issues, and improve quality.",
  "icon": "code",
  "sortOrder": 10,
  "isActive": true,
  "createdAt": "2026-04-06T10:00:00.000Z",
  "updatedAt": "2026-04-06T10:00:00.000Z"
}
```

### PromptTemplate
```json
{
  "id": "explain-code",
  "categoryId": "coding-help",
  "title": "Explain Code",
  "prompt": "Explain this code step-by-step for a beginner...",
  "description": "Best for beginner-friendly code explanation.",
  "tags": ["code", "explain", "beginner"],
  "language": "en",
  "isPublic": true,
  "isActive": true,
  "usageCount": 0,
  "sortOrder": 10,
  "createdBy": "system",
  "createdAt": "2026-04-06T10:00:00.000Z",
  "updatedAt": "2026-04-06T10:00:00.000Z"
}
```

### UserSavedPrompt
```json
{
  "id": "prompt-1743931000000-abcd1234",
  "userId": "user_001",
  "title": "My exam helper",
  "prompt": "Help me create a revision plan for pharmacology...",
  "sourceTemplateId": "explain-code",
  "isFavorite": false,
  "createdAt": "2026-04-06T10:00:00.000Z",
  "updatedAt": "2026-04-06T10:00:00.000Z"
}
```

## 1A) Prompt JSON Schemas (Ready to Use)

### Create Saved Prompt - Request Schema
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CreateSavedPromptRequest",
  "type": "object",
  "required": ["title", "prompt"],
  "additionalProperties": false,
  "properties": {
    "title": {
      "type": "string",
      "minLength": 2,
      "maxLength": 100
    },
    "prompt": {
      "type": "string",
      "minLength": 5,
      "maxLength": 5000
    },
    "sourceTemplateId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "isFavorite": {
      "type": "boolean",
      "default": false
    }
  }
}
```

### Update Saved Prompt - Request Schema
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "UpdateSavedPromptRequest",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "title": {
      "type": "string",
      "minLength": 2,
      "maxLength": 100
    },
    "prompt": {
      "type": "string",
      "minLength": 5,
      "maxLength": 5000
    },
    "isFavorite": {
      "type": "boolean"
    }
  },
  "anyOf": [
    { "required": ["title"] },
    { "required": ["prompt"] },
    { "required": ["isFavorite"] }
  ]
}
```

### Saved Prompt - Response Schema
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SavedPromptResponse",
  "type": "object",
  "required": ["id", "userId", "title", "prompt", "isFavorite", "createdAt", "updatedAt"],
  "additionalProperties": false,
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^prompt-[a-zA-Z0-9._-]+$",
      "maxLength": 80
    },
    "userId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "title": {
      "type": "string",
      "minLength": 2,
      "maxLength": 100
    },
    "prompt": {
      "type": "string",
      "minLength": 5,
      "maxLength": 5000
    },
    "sourceTemplateId": {
      "type": ["string", "null"],
      "maxLength": 64
    },
    "isFavorite": {
      "type": "boolean"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time"
    }
  }
}
```

## 2) API Endpoints

### GET /api/prompt-library/categories
Response:
```json
{
  "data": [
    {
      "id": "coding-help",
      "slug": "coding-help",
      "title": "Coding Help",
      "description": "Understand code, fix issues, and improve quality.",
      "icon": "code",
      "sortOrder": 10,
      "isActive": true
    }
  ]
}
```

### GET /api/prompt-library/templates?categoryId=coding-help&search=error&page=1&limit=20
Response:
```json
{
  "data": [
    {
      "id": "fix-error",
      "categoryId": "coding-help",
      "title": "Fix Error",
      "prompt": "Help me fix this error...",
      "description": "Root cause + corrected code + verification.",
      "tags": ["debug", "error"],
      "language": "en",
      "isPublic": true,
      "isActive": true,
      "usageCount": 147,
      "sortOrder": 20
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "hasNext": false
  }
}
```

### POST /api/prompt-library/saved
Request:
```json
{
  "title": "My SQL Helper",
  "prompt": "Explain this SQL query in simple terms.",
  "sourceTemplateId": "sql-to-query-builder"
}
```
Response:
```json
{
  "data": {
    "id": "prompt-1743931000000-abcd1234",
    "title": "My SQL Helper",
    "prompt": "Explain this SQL query in simple terms.",
    "sourceTemplateId": "sql-to-query-builder"
  }
}
```

### GET /api/prompt-library/saved
Response:
```json
{
  "data": [
    {
      "id": "prompt-1743931000000-abcd1234",
      "title": "My SQL Helper",
      "prompt": "Explain this SQL query in simple terms.",
      "sourceTemplateId": "sql-to-query-builder"
    }
  ]
}
```

### PATCH /api/prompt-library/saved/:id
Request:
```json
{
  "title": "My Updated SQL Helper",
  "prompt": "Explain this SQL query with examples."
}
```

### DELETE /api/prompt-library/saved/:id
Response:
```json
{
  "ok": true
}
```

## 3) Validation Rules

- `category.id`: required, lowercase slug, unique.
- `template.id`: required, lowercase slug, unique.
- `template.title`: required, 2 to 100 chars.
- `template.prompt`: required, 5 to 5000 chars.
- `saved.title`: required, 2 to 100 chars.
- `saved.prompt`: required, 5 to 5000 chars.
- `tags`: max 20 tags, each max 30 chars.
- `sortOrder`: integer, default 100.

## 4) Suggested SQL Tables

### prompt_categories
- `id` varchar(64) primary key
- `slug` varchar(64) unique not null
- `title` varchar(100) not null
- `description` text not null
- `icon` varchar(40) null
- `sort_order` int not null default 100
- `is_active` boolean not null default true
- `created_at` timestamp not null
- `updated_at` timestamp not null

### prompt_templates
- `id` varchar(64) primary key
- `category_id` varchar(64) not null references prompt_categories(id)
- `title` varchar(100) not null
- `prompt` text not null
- `description` text null
- `language` varchar(10) not null default 'en'
- `is_public` boolean not null default true
- `is_active` boolean not null default true
- `usage_count` int not null default 0
- `sort_order` int not null default 100
- `created_by` varchar(64) not null default 'system'
- `created_at` timestamp not null
- `updated_at` timestamp not null

### prompt_template_tags
- `template_id` varchar(64) not null references prompt_templates(id)
- `tag` varchar(30) not null
- primary key (`template_id`, `tag`)

### user_saved_prompts
- `id` varchar(64) primary key
- `user_id` varchar(64) not null
- `title` varchar(100) not null
- `prompt` text not null
- `source_template_id` varchar(64) null references prompt_templates(id)
- `is_favorite` boolean not null default false
- `created_at` timestamp not null
- `updated_at` timestamp not null

Indexes:
- `prompt_templates(category_id, is_active, sort_order)`
- `prompt_templates(title)`
- `user_saved_prompts(user_id, updated_at desc)`

## 5) Frontend Mapping Notes

- `PROMPT_LIBRARY_CATEGORIES` can be replaced with categories/templates API response.
- Keep current renderer fields: `id`, `title`, `description`, `prompt`, `categoryId`, `categoryTitle`.
- If API is unavailable, fallback to local static constants.

## 6) Runtime Auth Setup (Renderer)

Prompt Library now calls `https://ims.ifda.in/api/prompt-library` directly from renderer.

Set one of these auth modes in local storage:

1. Bearer mode
- `assistant.promptLibraryBearerToken` = `<TOKEN>`

2. Master secret mode
- `assistant.promptLibraryMasterSecret` = `<MASTER_SECRET>`
- `assistant.promptLibraryUserId` = `<USER_ID>`

Priority order:
- If bearer token exists, bearer mode is used.
- Else if master secret exists, master mode is used.
- Else saved prompts fallback to local storage only.
