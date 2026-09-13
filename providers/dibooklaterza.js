import fs from 'fs';
import path from 'path';
import { PDFDocument as CantooPDFDocument } from '@cantoo/pdf-lib';
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
        .option('output', {
            describe: 'Output filename',
            type: 'string',
            default: null
        })
        .help()
        .argv;

    async function removePassword(password, input, output) {
        await fs.promises.mkdir(
            path.dirname(output),
            { recursive: true }
        );

        const encryptedBytes = new Uint8Array(
            await fs.promises.readFile(input)
        );

        try {
            const pdfDoc = await CantooPDFDocument.load(
                encryptedBytes,
                { password }
            );

            const decryptedBytes = await pdfDoc.save();

            await fs.promises.writeFile(
                output,
                Buffer.from(decryptedBytes)
            );
        } catch (error) {
            throw new Error(
                `Impossibile decrittare ${input}: ${error.message}`
            );
        }
    }

    async function mergePages(pages, output) {
        await fs.promises.mkdir(
            path.dirname(output),
            { recursive: true }
        );

        const { spawn } = await import('child_process');

        await new Promise((resolve, reject) => {
            const process = spawn(
                'pdfunite',
                [...pages, output],
                {
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            );

            let stderr = '';

            process.stderr.on('data', data => {
                stderr += data.toString();
            });

            process.on('error', error => {
                reject(
                    new Error(
                        `Impossibile avviare pdfunite: ${error.message}`
                    )
                );
            });

            process.on('close', code => {
                if (code !== 0) {
                    reject(
                        new Error(
                            `pdfunite ha restituito codice ${code}: ${stderr.trim()}`
                        )
                    );
                    return;
                }

                resolve();
            });
        });
    }

    const sessionTmp =
        process.env.OURBOOKS_SESSION_TMP || './tmp';

    const outputDir =
        process.env.OURBOOKS_OUTPUT_DIR || '.';

    let userEmail = username || argv.username;
    let userPassword = password || argv.password;

    if (!userEmail) {
        const ans = await inquirer.prompt([
            {
                type: 'input',
                name: 'v',
                message: 'Email account DiBook Laterza:'
            }
        ]);

        userEmail = ans.v;
    }

    if (!userPassword) {
        const ans = await inquirer.prompt([
            {
                type: 'password',
                name: 'v',
                message: 'Password:'
            }
        ]);

        userPassword = ans.v;
    }

    console.log('Accesso a DiBook Laterza...');

    const loginRes = await fetch(
        'https://api.dibooklaterza.it/api/identity/login',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username: userEmail,
                password: userPassword
            })
        }
    );

    if (!loginRes.ok) {
        throw new Error(
            `Login fallito: ${loginRes.status} ${loginRes.statusText}`
        );
    }

    const loginData = await loginRes.json();

    const jwtToken = loginData.jwt;
    const laterzaUserId = loginData.laterzaUserId;

    if (!jwtToken || !laterzaUserId) {
        throw new Error(
            'Login fallito: risposta non valida'
        );
    }

    console.log('Recupero lista libri...');

    const booksRes = await fetch(
        `https://api.dibooklaterza.it/api/management/books/${laterzaUserId}`,
        {
            headers: {
                Authorization: `Bearer ${jwtToken}`
            }
        }
    );

    if (!booksRes.ok) {
        throw new Error(
            `Impossibile recuperare i libri: ` +
            `${booksRes.status} ${booksRes.statusText}`
        );
    }

    const booksData = await booksRes.json();

    const libreriaCategory =
        booksData.categories?.find(
            c => c.name?.toLowerCase() === 'libreria'
        );

    if (!libreriaCategory) {
        throw new Error(
            "Categoria 'libreria' non trovata"
        );
    }

    const libreriaBooks =
        (booksData.books || []).filter(
            b =>
                b.category === libreriaCategory.id &&
                b.permitDownload &&
                b.existPdf
        );

    if (libreriaBooks.length === 0) {
        throw new Error(
            'Nessun libro scaricabile trovato nella libreria'
        );
    }

    let bookIsbn = isbn
        ? String(isbn)
        : argv.isbn
            ? String(argv.isbn)
            : null;

    if (!bookIsbn) {
        const { selectedIsbn } =
            await inquirer.prompt([
                {
                    type: 'list',
                    name: 'selectedIsbn',
                    message: 'Seleziona il libro da scaricare:',
                    choices: libreriaBooks.map(b => ({
                        name: `${b.title} (${b.identifier})`,
                        value: b.identifier
                    }))
                }
            ]);

        bookIsbn = selectedIsbn;
    }

    const authorization =
        `Bearer ${jwtToken}`;

    console.log('Fetching book index...');

    const indexRes = await fetch(
        `https://api.dibooklaterza.it/api/reader/${bookIsbn}/index`,
        {
            headers: {
                authorization
            }
        }
    );

    if (!indexRes.ok) {
        throw new Error(
            `Impossibile recuperare l'indice: ` +
            `${indexRes.status} ${indexRes.statusText}`
        );
    }

    const bookIndex = await indexRes.json();

    console.log(`Downloading ${bookIndex.name}`);

    const bookPassword =
        `AB8374JJ${bookIsbn.padEnd(16, '0')}H48js83A`;

    await fs.promises.mkdir(
        sessionTmp,
        { recursive: true }
    );

    const pages = [];

    for (const chapter of bookIndex.chapters) {
        for (const pageLabel of chapter.pageLabels) {
            console.log(
                `Downloading page ${pageLabel}`
            );

            const encryptedDir = path.join(
                sessionTmp,
                'encrypted',
                String(chapter.id)
            );

            const decryptedDir = path.join(
                sessionTmp,
                'pages',
                String(chapter.id)
            );

            await fs.promises.mkdir(
                encryptedDir,
                { recursive: true }
            );

            await fs.promises.mkdir(
                decryptedDir,
                { recursive: true }
            );

            const encryptedPath = path.join(
                encryptedDir,
                `${pageLabel}.pdf`
            );

            const decryptedPath = path.join(
                decryptedDir,
                `${pageLabel}.pdf`
            );

            const pageUrlRes = await fetch(
                `https://api.dibooklaterza.it/api/reader/` +
                `${bookIsbn}/${chapter.id}/pdf-secure/${pageLabel}`,
                {
                    headers: {
                        authorization
                    }
                }
            );

            if (!pageUrlRes.ok) {
                throw new Error(
                    `Errore nel recupero della pagina ${pageLabel}: ` +
                    `${pageUrlRes.status} ${pageUrlRes.statusText}`
                );
            }

            const pageUrl =
                await pageUrlRes.text();

            const pageRes =
                await fetch(pageUrl);

            if (!pageRes.ok) {
                throw new Error(
                    `Errore nel download della pagina ${pageLabel}: ` +
                    `${pageRes.status} ${pageRes.statusText}`
                );
            }

            const page =
                await pageRes.arrayBuffer();

            await fs.promises.writeFile(
                encryptedPath,
                Buffer.from(page)
            );

            await removePassword(
                bookPassword,
                encryptedPath,
                decryptedPath
            );

            if (pageLabel === '17') {
                console.log(`Test PDF decrittato: ${decryptedPath}`);
            }
                        pages.push(decryptedPath);
                    }
                }

    console.log('Merging pages...');

    const outFileName =
        bookIndex.name
            .replace(/[^a-z0-9]/gi, '_') +
        '.pdf';

    const outFilePath = path.join(
        outputDir,
        output || outFileName
    );

    await mergePages(
        pages,
        outFilePath
    );

    console.log('Cleaning up...');

    await fs.promises.rm(
        sessionTmp,
        {
            recursive: true,
            force: true
        }
    );

    console.log(
        `Done! File salvato: ${outFilePath}`
    );

    console.log(
        `OURBOOKS_OUTPUT:${outFilePath}`
    );
}