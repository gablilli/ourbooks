# ourbooks

UI per gestire e scaricare libri digitali da piattaforme educative italiane.

## Providers supportati
- Sanoma Italia
- Zanichelli
- bSmart
- HUB Scuola
- Dibook Laterza

## Avviare la UI

### Con Docker

```bash
docker build -t ourbooks .
docker run -p 7860:7860 ourbooks
```

Apri poi <http://localhost:7860> nel browser.

### Con Node.js

```bash
npm install
npm run ui
```

Apri poi <http://localhost:3000> nel browser.
