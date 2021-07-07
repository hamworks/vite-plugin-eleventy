const EleventyJSONWatch = require('./lib/Eleventy');
const del = require('del');
const deleteEmpty = require('delete-empty');
const { extname } = require('path');
const path = require('path');

const eleventyPlugin = (opts = {}) => {
  let config;
  let eleventy;
  let files = [];
  let output = [];
  let base;

  // Set up user options
  const options = Object.assign(
    {
      replace: [['/index.html', '']],
    },
    opts,
  );

  const contentTypes = {
    js: 'application/javascript',
    css: 'text/css',
    html: 'text/html',
    json: 'application/json',
  };

  return {
    name: 'eleventy',
    enforce: 'pre',

    // This _should_ be done in configResolved but we need to generate the HTML and the input files _before_ the config gets resolved. As a compromise, this an error will be thrown in configResolved if the root changes.
    async config(config, { command }) {
      // Determine Vite's root. Because it can be an absolute or relative path, we're `path.resolve`ing it, then figuring out the relative path because that's what Eleventy needs.
      base = config.root ? path.resolve(config.root) : process.cwd();
      base = path.relative(process.cwd(), base) || '.';

      eleventy = new EleventyJSONWatch(base, base);
      await eleventy.init();
      files = await eleventy.toJSON();

      // On build, write files, glob the HTML, and add them to Build Rollup Options
      if (command === 'build') {
        await eleventy.write();

        // Add outputPath to files, needed until https://github.com/11ty/eleventy/issues/1877 is resolved
        // Will be removed once Eleventy supports it natively
        // Only adds index.html if the file's URL doesn't already have an extension
        files = files.map((f) => {
          let outputPath = path.join(base, f.url);
          if (path.extname(f.url) === '') {
            outputPath = path.join(outputPath, 'index.html');
          }

          return Object.assign({}, f, { outputPath });
        });

        // Add relative path to replacements for build files.
        if (base !== '.') {
          options.replace.unshift([base, '']);
        }

        // Determine output file object
        output = files.reduce((acc, cur) => {
          let name = cur.outputPath;
          // Removes all "replacements" from the output path to build name
          for (const r of options.replace) {
            name = name.replace(r[0], r[1]);
          }
          name = name.startsWith('/') ? name.substring(1) : name;

          acc[name] = cur.outputPath;
          return acc;
        }, {});

        // Return 11ty rollup inputs
        return {
          build: {
            rollupOptions: {
              input: output,
            },
          },
        };
      }
    },

    configResolved(resolvedConfig) {
      // If the root changes, throw an error
      if (path.resolve(base) !== resolvedConfig.root) {
        throw new Error(
          'A plugin has changed the Vite root after [vite-plugin-eleventy] has run. Please make sure any plugins that change the Vite root run before this one.',
        );
      }
      config = resolvedConfig;
    },

    // Clean up the compiled files and empty directories after stuff gets compiled
    async closeBundle() {
      await del(Object.values(output));
      await deleteEmpty(config.root);
    },

    // Configures dev server to respond with virtual 11ty output
    configureServer(server) {
      // Set up 11ty watcher and reload.
      eleventy.watch();
      eleventy.config.events.on('watchChange', (f) => {
        files = f;
        if (server.ws) {
          server.ws.send({
            type: 'full-reload',
            event: 'eleventy-update',
            data: {},
          });
        }
      });

      server.middlewares.use(async (req, res, next) => {
        // Need to grab the pathname, not the request url, to match against 11ty output
        const { pathname } = req._parsedUrl;
        const url = pathname.endsWith('/') ? pathname : `${pathname}/`;

        // Find the file if it exists!
        const output = files.find((r) => r.url === url);
        if (output) {
          let ct = '';

          // Manage transforms and content types
          if ((extname(url) === '' && url.endsWith('/')) || extname(url) === '.html') {
            // If it's an HTML file our a route, run it through transformIndexHtml
            output.content = await server.transformIndexHtml(url, output.content, req.originalUrl);
            ct = 'html';
          } else {
            // Otherwise, run it through transformRequest
            output.content = await server.transformRequest(url, output.content, req.originalUrl);
            ct = extname(url).replace('.', '');
          }

          return res
            .writeHead(200, {
              'Content-Length': Buffer.byteLength(output.content),
              'Content-Type': contentTypes[ct] || 'text/plain',
            })
            .end(output.content);
        }

        return next();
      });
    },
  };
};

module.exports = {
  eleventyPlugin,
};
