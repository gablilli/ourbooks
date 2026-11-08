import PromptSync from "prompt-sync";
import path from "path";
import yargs from "yargs";
import { fileURLToPath } from "url";
import { createSession } from "./src/zanichelli/login.js";
import { getUser, listBooks, resolveReaderUrl } from "./src/zanichelli/catalog.js";
import { downloadKitabooBook } from "./src/zanichelli/kitaboo.js";
import { downloadBookTabBook } from "./src/zanichelli/booktab.js";

const prompt = PromptSync({ sigint: true });

const argv = yargs(process.argv.slice(2))
	.option("username", {
		alias: "u",
		type: "string",
		description: "Username(email)",
	})
	.option("password", {
		alias: "p",
		type: "string",
		description: "Password",
	})
	.option("isbn", {
		alias: "i",
		type: "string",
		description: "ISBN",
	})
	.option("booktab-isbn", {
		alias: "b",
		type: "string",
		description: "Overwrite the booktab ISBN (which is different from the normal ISBN)",
	})
	.help()
	.alias("help", "h")
	.argv;

export async function run(options = {}) {
	let username = options.username || argv.username;
	let password = options.password || argv.password;
	const outputDir = process.env.OURBOOKS_OUTPUT_DIR || '.';

	while (!username)
		username = prompt("Username(email): ");

	while (!password)
		password = prompt("Password: ");

	console.log("Logging in...");

	let session;
	try {
		session = await createSession(username, password);
	} catch (err) {
		console.log(err.message);
		process.exit(1);
	}

	console.log("Fetching available books...");

	await getUser(session).then((res) => {
		console.log(`Logged in as: ${res.firstName} ${res.lastName}`);
	}).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	let books = {};
	try {
		books = await listBooks(session);
	} catch (err) {
		console.log(err.message);
	}

	if (!Object.keys(books).length) {
		console.log("No books found");
		process.exit(0);
	}

	console.log("Available books:");
	console.table(books, ['title']);

	let isbn = options.isbn || argv.isbn;

	while (!isbn)
		isbn = prompt("ISBN: ");

	if (!books[isbn]) {
		const match = Object.keys(books).find((key) => books[key].isbns.includes(isbn));
		if (!match) {
			console.log("ISBN non trovato tra i tuoi libri");
			process.exit(1);
		}
		isbn = match;
	}

	console.log("Detecting reader...");

	let bookReaderUrl;
	try {
		bookReaderUrl = await resolveReaderUrl(books[isbn].ereader_url, session.catalogHeaders.cookie);
	} catch (err) {
		console.log("Error: ", err.message);
		process.exit(1);
	}

	if (bookReaderUrl.host == 'web-booktab.zanichelli.it') {
		console.log("BookTab book detected");
		await downloadBookTabBook(books[isbn].ereader_url, session.cookie, outputDir, argv["booktab-isbn"]);
	} else {
		console.log("Kitaboo book detected");
		await downloadKitabooBook(bookReaderUrl, outputDir, session.sessionCookieHeader);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}