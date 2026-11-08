# ourbooks

ui pulita e cli per scaricare i tuoi libri digitali dalle piattaforme degli editori italiani.

## provider supportati

- sanoma italia
- zanichelli
- bsmart e digibook24
- hub scuola (hubyoung e hubkids)
- dibook laterza

## requisiti

- node.js 20 o superiore
- npm

se usi docker trovi già pdftk e java nell'immagine, ma non ocrmypdf, quindi l'ocr di zanichelli non è disponibile nel container.

## installazione

```bash
git clone https://github.com/gablilli/ourbooks.git
cd ourbooks
npm install
```

## uso con interfaccia web

```bash
npm run ui
```

in alternativa `npm start`, che fa la stessa cosa. poi apri http://localhost:3000 nel browser.

1. scegli l'editore
2. inserisci email e password del tuo account
3. seleziona il libro dalla lista che viene caricata automaticamente
4. avvia il download e segui l'avanzamento nel terminale integrato
5. a fine lavoro il pdf si scarica dalla pagina stessa

i file generati finiscono nella cartella `downloads/`, divisa per sessione. per cambiare porta imposta la variabile d'ambiente port (di default 3000).

## uso da riga di comando

```bash
npm run cli
```

parte un menu interattivo che chiede l'editore e poi le credenziali. puoi saltare il menu indicando il provider direttamente:

```bash
npm run cli -- --provider sanoma
```

i provider disponibili sono `sanoma`, `hubscuola`, `dibooklaterza`, `zanichelli`, `bsmart`. tutte le altre opzioni vengono passate al provider scelto. se manca qualcosa, il provider te lo chiede in modo interattivo.

### opzioni per provider

sanoma

- `--id` o `-i`: email dell'account
- `--password` o `-p`: password
- `--gedi` o `-g`: codice gedi del libro
- `--output` o `-o`: nome del file di output
- `--pages`: pagine da scaricare, per esempio `1-10,15`

hubscuola

- `--platform` o `-p`: `hubyoung` oppure `hubkids`
- `--username` o `-u` e `--password` o `-w`: credenziali
- `--token` o `-t`: token di sessione, in alternativa alle credenziali
- `--volumeId` o `-v`: id del volume
- `--file` o `-f`: nome del file di output
- `--annotations` o `-a`: scarica e integra le annotazioni
- `--noCleanUp` o `-n`: non cancella la cartella temporanea

dibook laterza

- `--username` e `--password`: credenziali
- `--isbn`: isbn del libro, se omesso viene mostrata la lista
- `--output`: nome del file di output

zanichelli

- `--username` o `-u` e `--password` o `-p`: credenziali
- `--isbn` o `-i`: isbn del libro
- `--booktab-isbn` o `-b`: sovrascrive l'isbn booktab, che può essere diverso da quello normale
- `--ocr`: esegue l'ocr sul pdf finale (`on` oppure `off`)

bsmart e digibook24

- `--site`: `bsmart` oppure `digibook24`
- `--username` o `-u` e `--password` o `-w`: credenziali
- `--cookie`: cookie di sessione, in alternativa alle credenziali
- `--bookId`: id del libro
- `--output`: nome del file di output
- `--annotations`: disegna le annotazioni sul pdf unito
- `--resources`: scarica le risorse del libro invece del libro
- `--concurrency`: numero di download in parallelo (default 4)
- `--downloadOnly`: scarica le pagine singole senza unirle
- `--pdftk`: scarica le pagine e le unisce con pdftk
- `--pdftkPath`: percorso dell'eseguibile pdftk (default `pdftk`)
- `--checkMd5`: verifica l'md5 dei file scaricati

per vedere tutte le opzioni di un provider usa `--help`, per esempio `node providers/zanichelli.js --help`.

### script extra

```bash
npm run hub:docenti -- --platform hubyoung --volumeId <id> --token <token>
```

scarica il livello docenti di un volume hub scuola. opzioni utili: `--resume` per riprendere da un checkpoint, `--fromIndex` e `--toIndex` per limitare le pagine, `--timeoutMs` e `--retries` per rete instabile.

## docker

l'immagine viene pubblicata automaticamente su ghcr a ogni push.

```bash
docker run -p 7860:7860 ghcr.io/gablilli/ourbooks:latest
```

poi apri http://localhost:7860. per costruirla in locale:

```bash
docker build -t ourbooks .
docker run -p 7860:7860 ourbooks
```

## deploy

- render: il file `render.yaml` è già pronto, basta collegare la repo e scegliere il runtime docker
- hugging face spaces: il workflow `sync.yml` sincronizza la repo con uno space docker a ogni push su main. servono i secret `HF_TOKEN` e `HF_REPO_ID` nelle impostazioni della repo

## aggiungere un provider

crea `providers/nomeprovider.js` che esporta una funzione `run(options)`, poi aggiungi il nome alla lista in `cli.js` e i campi del form in `server.js`. le pull request sono benvenute, soprattutto per editori che non ho modo di testare.

## crediti

buona parte del lavoro è stato fatto da [leone25](https://github.com/leone25) a cui va un grande grazie, poi continuato da me per costruire la ui, migliorare i processi di login e download e l'esportazione per alcuni provider (sanoma, zanichelli, hubscuola).

## disclaimer

questo progetto è stato creato esclusivamente a scopo di studio e a fini didattici. non incoraggia né promuove la violazione del diritto d'autore. usalo solo con libri che possiedi regolarmente e rispetta i termini di servizio degli editori. l'autore non si assume alcuna responsabilità per l'uso che ne fai, che resta a tuo rischio.

## licenza

mit
