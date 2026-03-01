import yargs from "yargs";
import inquirer from "inquirer";

const argv = yargs(process.argv.slice(2))
  .option("provider", {
    alias: "p",
    type: "string",
    description: "Provider name"
  })
  .help()
  .argv;

async function selectProvider() {
  if (argv.provider) return argv.provider;

  const { provider } = await inquirer.prompt([
    {
      type: "list",
      name: "provider",
      message: "Seleziona editore:",
      choices: [
        "sanoma",
        "hubscuola",
        "dibooklaterza",
        "zanichelli"
        // there'll be more providers in the future, but I currently don't have books to test em so if you want to contribute feel free to open a PR with your provider implementation
      ]
    }
  ]);

  return provider;
}

async function main() {
  const provider = await selectProvider();

  try {
    const module = await import(`./providers/${provider}.js`);

    if (!module.run) {
      console.error("Il provider non esporta una funzione run()");
      process.exit(1);
    }

    await module.run({});
  } catch (err) {
    console.error("Errore caricando il provider:", err.message);
    process.exit(1);
  }
}

main();