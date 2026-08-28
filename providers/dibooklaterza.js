import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import inquirer from 'inquirer';

export async function run(options = {}) {
  const {
    username,
    password,
    isbn,
    output
  } = options;

  const argv = yargs(hideBin(process.argv.slice(2)))
        .option('username', {
            describe: 'Email account DiBook Laterza',
            type: 'string',
            default: null
        })
        .option('password', {
            describe: 'Password account DiBook Laterza',
            type: 'string',
            default: null
        })
        .option('isbn', {
            describe: 'ISBN del libro (opzionale, se non specificato viene mostrata la lista)',
            type: 'string',
            default: null
        })
        .option('pdftkJava', {
            describe: 'The path to the pdftk-java jar file',
            type: 'string',
            default: './pdftk-all.jar'
        })
        .option('javaPath', {
            describe: 'Path to java executable',
            type: 'string',
            default: 'java'
        })
        .option('useSystemExecutable', {
            describe: 'Use the executable directly instead of running the jar with java, this is usefuly if you are on linux where most package managers install the java version by default thus you don\'t need java',
            type: 'boolean',
            default: false
        })
        .option('pdftkPath', {
            describe: 'Path to pdftk executable',
            type: 'string',
            default: 'pdftk'
        })
        .option('output', {
            describe: 'Output filename',
            type: 'string',
            default: null
        })
        .help()
        .argv;

    function pdftk(...args) {
        if (argv.useSystemExecutable) {
            return spawn(argv.pdftkPath, args);
        } else {
            return spawn(argv.javaPath, ['-jar', argv.pdftkJava, ...args]);
        }
    }

    function removePassword(password, input, output) {
        return new Promise(async (resolve, reject) => {
            if (!fs.existsSync(path.dirname(output))) {
                await fs.promises.mkdir(path.dirname(output), { recursive: true });
            }

            let converter = pdftk(input, 'input_pw', password, 'output', output);
            converter.on('close', resolve);
        });
    }

    function mergePages(pages, output) {
        return new Promise(async (resolve, reject) => {
            if (!fs.existsSync(path.dirname(output))) {
                await fs.promises.mkdir(path.dirname(output), { recursive: true });
            }

            let merger = pdftk(...pages, 'cat', 'output', output);
            merger.on('close', resolve);
        });
    }

    (async () => {
        if (!argv.useSystemExecutable && !fs.existsSync(argv.pdftkJava)) {
            console.error('pdftk-all.jar non trovato.\nAssicurati che il file esista in ./pdftk-all.jar oppure usa --useSystemExecutable con pdftk installato nel sistema.');
            process.exitCode = 1;
            return;
        }

        const sessionTmp = process.env.OURBOOKS_SESSION_TMP || './tmp';
        const outputDir = process.env.OURBOOKS_OUTPUT_DIR || '.';

        let userEmail = username || argv.username;
        let userPassword = password || argv.password;

        if (!userEmail) {
            const ans = await inquirer.prompt([{ type: 'input', name: 'v', message: 'Email account DiBook Laterza:' }]);
            userEmail = ans.v;
        }
        if (!userPassword) {
            const ans = await inquirer.prompt([{ type: 'password', name: 'v', message: 'Password:' }]);
            userPassword = ans.v;
        }

        // Login
        console.log("Accesso a DiBook Laterza...");
        const loginRes = await fetch('https://api.dibooklaterza.it/api/identity/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: userEmail, password: userPassword })
        });

        if (!loginRes.ok) {
            throw new Error(`Login fallito: ${loginRes.status} ${loginRes.statusText}`);
        }

        const loginData = await loginRes.json();
        const jwtToken = loginData.jwt;
        const laterzaUserId = loginData.laterzaUserId;

        if (!jwtToken || !laterzaUserId) {
            throw new Error("Login fallito: risposta non valida");
        }

        // Recupera lista libri
        console.log("Recupero lista libri...");
        const booksRes = await fetch(`https://api.dibooklaterza.it/api/management/books/${laterzaUserId}`, {
            headers: { 'Authorization': `Bearer ${jwtToken}` }
        });

        if (!booksRes.ok) {
            throw new Error(`Impossibile recuperare i libri: ${booksRes.status} ${booksRes.statusText}`);
        }

        const booksData = await booksRes.json();

        // Trova la categoria "libreria"
        const libreriaCategory = booksData.categories?.find(c => c.name?.toLowerCase() === 'libreria');
        if (!libreriaCategory) {
            throw new Error("Categoria 'libreria' non trovata");
        }

        const libreriaBooks = (booksData.books || []).filter(b => b.category === libreriaCategory.id && b.permitDownload && b.existPdf);

        if (libreriaBooks.length === 0) {
            throw new Error("Nessun libro scaricabile trovato nella libreria");
        }

        // Seleziona il libro
        let bookIsbn = isbn ? String(isbn) : (argv.isbn ? String(argv.isbn) : null);
        if (!bookIsbn) {
            const { selectedIsbn } = await inquirer.prompt([{
                type: 'list',
                name: 'selectedIsbn',
                message: 'Seleziona il libro da scaricare:',
                choices: libreriaBooks.map(b => ({
                    name: `${b.title} (${b.identifier})`,
                    value: b.identifier
                }))
            }]);
            bookIsbn = selectedIsbn;
        }

        let authorization = 'Bearer ' + jwtToken;

        console.log("Fetching book index");
        
        let bookIndex = await fetch(`https://api.dibooklaterza.it/api/reader/${bookIsbn}/index`, {
            headers: {authorization}
        }).then(res => res.json());

        console.log(`Downloading ${bookIndex.name}`);

        let pages = [];
        const bookPassword = `AB8374JJ${bookIsbn.padEnd(16, "0")}H48js83A`;
        
        await fs.promises.mkdir(sessionTmp, {recursive: true});

        for (let i = 0; i < bookIndex.chapters.length; i++) {
            let chapter = bookIndex.chapters[i];
            for (let j = 0; j < chapter.pageLabels.length; j++) {
                console.log(`Downloading page ${chapter.pageLabels[j]}`);
                pages.push(`${chapter.id}/${chapter.pageLabels[j]}.pdf`);
                fs.promises.mkdir(`${sessionTmp}/password/${chapter.id}`, {recursive: true})
                let pageUrl = await fetch(`https://api.dibooklaterza.it/api/reader/${bookIsbn}/${chapter.id}/pdf-secure/${chapter.pageLabels[j]}`, {
                    headers: {authorization}
                }).then(res => res.text());
                let page = await fetch(pageUrl).then(res => res.arrayBuffer());
                await fs.promises.writeFile(`${sessionTmp}/password/${chapter.id}/${chapter.pageLabels[j]}.pdf`, Buffer.from(new Uint8Array(page)));
                await removePassword(bookPassword, `${sessionTmp}/password/${chapter.id}/${chapter.pageLabels[j]}.pdf`, `${sessionTmp}/pages/${chapter.id}/${chapter.pageLabels[j]}.pdf`);
            }
        }

        console.log("Merging pages");

        const outFileName = bookIndex.name.replace(/[^a-z0-9]/gi, '_') + '.pdf';
        const outFilePath = path.join(outputDir, outFileName);
        await mergePages(pages.map(p => `${sessionTmp}/pages/${p}`), outFilePath);

        console.log("Cleaning up");

        await fs.promises.rm(sessionTmp, { recursive: true, force: true });

        console.log(`Done! File salvato: ${outFilePath}`);
        console.log(`OURBOOKS_OUTPUT:${outFilePath}`);
    })();
}