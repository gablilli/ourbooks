import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { renderPageWorker } from './pdf-renderer.js';

export async function runPageWorker() {
  const queue = [];

  let processing = false;

  async function processMessage(message) {
    processing = true;

    try {
      await renderPageWorker(
        message.page,
        message.pageIndex,
        message.totalPages,
        message.headers,
        message.outputPath,
        message.fonts,
        message.imageBuffer
      );

      if (typeof process.send === 'function') {
        process.send({
          ok: true,
          pageNumber: message.page.pageNumber
        });
      }
    } catch (error) {
      if (typeof process.send === 'function') {
        process.send({
          ok: false,
          pageNumber: message.page?.pageNumber,
          error: error?.message || String(error)
        });
      }
    } finally {
      processing = false;

      if (queue.length > 0) {
        const nextMessage = queue.shift();

        await processMessage(nextMessage);
      }
    }
  }

  process.on('message', message => {
    if (processing) {
      queue.push(message);
      return;
    }

    processMessage(message).catch(error => {
      if (typeof process.send === 'function') {
        process.send({
          ok: false,
          error: error?.message || String(error)
        });
      }
    });
  });

}


export function createWorker() {
  const workerPath = fileURLToPath(
    new URL('../../sanoma.js', import.meta.url)
  );

  const child = fork(
    workerPath,
    [],
    {
      env: {
        ...process.env,
        OURBOOKS_SANOMA_PAGE_WORKER: '1'
      },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    }
  );

  child.on('error', error => {
    console.error(
      `Sanoma worker error: ${error.message}`
    );
  });

  child.on('exit', (code, signal) => {
    if (code !== 0) {
      console.error(
        `Sanoma worker terminato: code=${code}, signal=${signal || 'none'}`
      );
    }
  });

  return child;
}


export function runPageInProcess(
  child,
  page,
  pageIndex,
  totalPages,
  headers,
  outputPath,
  fonts,
  imageBuffer
) {
  return new Promise(
    (resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        child.off(
          'message',
          onMessage
        );

        child.off(
          'error',
          onError
        );

        child.off(
          'exit',
          onExit
        );
      };

      const finish = (
        error = null
      ) => {
        if (settled) {
          return;
        }

        settled = true;

        cleanup();

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const onMessage = message => {
        if (
          message?.pageNumber !==
          page.pageNumber
        ) {
          return;
        }

        if (message.ok) {
          finish();
        } else {
          finish(
            new Error(
              message.error ||
              `Page worker failed for page ${page.pageNumber}`
            )
          );
        }
      };

      const onError = error => {
        finish(error);
      };

      const onExit = code => {
        if (settled) {
          return;
        }

        finish(
          new Error(
            `Page worker exited with code ${code}`
          )
        );
      };

      child.on(
        'message',
        onMessage
      );

      child.once(
        'error',
        onError
      );

      child.once(
        'exit',
        onExit
      );

      try {
        child.send(
          {
            page,
            pageIndex,
            totalPages,
            headers,
            outputPath,
            fonts,
            imageBuffer
          },
          error => {
            if (error) {
              finish(error);
            }
          }
        );
      } catch (error) {
        finish(error);
      }
    }
  );
}
