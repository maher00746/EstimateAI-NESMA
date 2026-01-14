# Estimation Knowledge Base

This project consists of a TypeScript/Express backend responsible for ingesting PC build documents, extracting dynamic attribute maps, persisting both the raw text and structured information inside MongoDB, and matching new estimates against historical data.

## Key Modules

- `src/modules/ingestion`: handles file uploads and delegates parsing.
- `src/services/parsing`: extracts text from PDF/DOCX/TXT, normalizes attribute names, and outputs flexible dictionaries.
- `src/modules/storage`: exposes repository helpers that persist builds and query history without imposing a rigid schema.
- `src/modules/matching`: scores candidate builds against a reference using attribute overlap, numeric proximity, and string similarity.
- `src/routes/estimates.ts`: REST API for upload, match, and history.

## Environment

Copy `.env.example` to `.env`, populate `MONGO_URI`, and set `OPENAI_API_KEY`. The backend reads:

```
PORT=4000
MONGO_URI=mongodb+srv://<username>:<password>@storymagic.79u7oqk.mongodb.net/estimation_kb?retryWrites=true&w=majority
UPLOAD_DIR=uploads/raw
STATIC_DIR=uploads/raw
```

Use your MongoDB Atlas URI and ensure it points to the `estimation_kb` database (the one we want to seed with builds). The backend will automatically create collections and documents when new uploads are ingested.

### AI-powered parsing

Uploads now send the extracted text to OpenAI (`gpt-4o-mini`) and instruct it to return every attribute/value pair plus the total price in JSON. The backend persists the raw text, the JSON attributes, and the total price, then exposes those builds via `/api/estimates/history`. While OpenAI is running, the frontend shows a processing overlay so users know the request is pending.

## Startup

1. Install packages: `npm install`.
2. Build: `npm run build`.
3. Run (dev): `npm run dev` or `npm start` after building.

Uploads hit `/api/estimates/upload`, matching uses `/api/estimates/match`, and the knowledge base can be viewed at `/api/estimates/history`.

## Next Steps

- Build the React/Vite frontend that calls these endpoints, renders the knowledge base, presents upload/scan controls, and surfaces match results in a professional dashboard layout with a sidebar navigation.
- Flesh out matching semantics (e.g., GPU family hints) and add CI/business validations for extracted attributes.

