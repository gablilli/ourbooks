import PromptSync from "prompt-sync";
import fetch from "node-fetch";
import { parseStringPromise as parseString } from "xml2js";
import PDFMerger from "pdf-merger-js";
import fs from "fs";
import path from "path";

const prompt = PromptSync({ sigint: true });

export async function downloadBookTabBook(redirectUrl, cookie, outputDir, booktabIsbn) {
	let isbn = redirectUrl.split('/');
	isbn = booktabIsbn || isbn[isbn.length - 1];

	console.log("Accessing booktab...");

	let bookTabSession = await fetch('https://web-booktab.zanichelli.it/api/v1/sessions_web', {
		method: 'POST',
		headers: { cookie },
	}).then((res) => res.json()).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	cookie += `; booktab_token=${bookTabSession.session}`;

	while (!isbn)
		isbn = prompt("ISBN: ");

	console.log("Fetching book details...");

	let spine = await fetch(`https://web-booktab.zanichelli.it/api/v1/resources_web/${isbn}/spine.xml`, {
		headers: { cookie },
	}).then(async (res) => {
		if (res.status == 404) {
			return fetch(`https://web-booktab.zanichelli.it/api/v1/resources_web/${isbn}/volume.xml`, {
				headers: { cookie },
			}).then((res) => {
				if (res.status == 404) {
					console.log('Looks like this is not a downloadable book, try another one.');
					process.exit(1);
				}
				return res.text();
			});
		}
		return res.text();
	}).then(parseString).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	const title = (spine.spine || spine.config.volume[0].settings[0]).volumetitle[0].trim().replace(/[^a-z0-9]/gi, '_');

	console.log("Downloading book...");

	const units = (spine.spine ? spine.spine.unit : spine.config.volume[0].units[0].unit).map((unit) => {
		if (unit.$.features == 'flash') return null;
		return unit.$.btbid;
	}).filter((unit) => unit != null);

	let pdfMerger = new PDFMerger();

	let isXps = false;

	for (let i = 0; i < units.length; i++) {
		console.log(`Downloading unit ${i + 1} of ${units.length}`);
		const unit = units[i];
		let config = await fetch(`https://web-booktab.zanichelli.it/api/v1/resources_web/${isbn}/${unit}/config.xml`, {
			headers: { cookie },
		}).catch((err) => {
			console.log("Error: ", err);
			process.exit(1);
		});

		if (config.status != 200) continue;

		config = await config.text().then(parseString);

		let pdfUrl = config.unit.content[0];

		if (config.unit.filesMap) {
			pdfUrl = config.unit.filesMap[0].entry.find((file) => file.$.key == config.unit.content[0] + '.pdf')._;
		}

		if (isXps) {
			let xps = await fetch(`https://web-booktab.zanichelli.it/api/v1/resources_web/${isbn}/${unit}/${config.unit.content[0]}.xod`, {
				headers: { cookie },
			}).then((res) => res.buffer()).catch((err) => {
				console.log("Error: ", err);
				process.exit(1);
			});

			await fs.promises.writeFile(path.join("xps_" + title, `${i}_${unit}.xps`), xps);
			continue;
		}

		let pdf = await fetch(`https://web-booktab.zanichelli.it/api/v1/resources_web/${isbn}/${unit}/${pdfUrl}.pdf`, {
			headers: { cookie },
		}).catch((err) => {
			console.log("Error: ", err);
			process.exit(1);
		});

		if (pdf.status == 404) {
			isXps = true;
			i = -1; // restart the loop
			console.log("DETECTED XPS FORMAT, DOWNLOADING INDIVIDUAL UNITS...");
			await fs.promises.mkdir("xps_" + title, { recursive: true }); // adding prefix to gitignore
			continue;
		}

		pdf = await pdf.buffer();
		await pdfMerger.add(pdf);
	}

	if (isXps) {
		console.log("Done! You'll find the XPS files in the directory of the script");
		console.log("Instructions:");
		console.log("1. A folder with the name of the book will be created, containing all the units in XPS format");
		console.log("2. Navigate to https://xpstopdf.com/ and convert the XPS files to PDF format");
		console.log("3. Merge the PDF files using https://www.ilovepdf.com/merge_pdf");
		console.log("If anyone would like to contribute a script to automate this process, feel free to do so");
	} else {
		console.log("Saving...");
		const pdfPath = path.join(outputDir, title + '.pdf');
		console.log("PDF path will be: " + pdfPath);

		try {
			await pdfMerger.save(pdfPath);
			console.log("pdfMerger.save() completed");
		} catch (mergeErr) {
			console.error("Error during pdfMerger.save():", mergeErr.message);
			process.exit(1);
		}

		let fileExists = false;
		for (let i = 0; i < 50; i++) {
			try {
				const stats = await fs.promises.stat(pdfPath);
				console.log(`Check ${i + 1}: File size = ${stats.size} bytes`);
				if (stats.size > 0) {
					fileExists = true;
					console.log("File found!");
					break;
				}
			} catch (e) {
				console.log(`Check ${i + 1}: File not found yet`);
			}
			await new Promise(resolve => setTimeout(resolve, 200));
		}

		if (!fileExists) {
			console.error('PDF file was not created');
			console.error('Expected file: ' + pdfPath);
			console.error('Current directory: ' + process.cwd());
			process.exit(1);
		}

		console.log("Done! PDF saved: " + pdfPath);
		console.log(`OURBOOKS_OUTPUT:${pdfPath}`);
	}
}