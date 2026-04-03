## Dummy C heartbeat server

The repository also includes a small cross-platform C program that:

- Prints one JSON heartbeat line every 5 seconds
- Spawns a Node.js child process that loads `index.js` as a module via `bin/dummy_bootstrap.js`
- Exits fail-fast if the Node child exits unexpectedly

Example output:

```json
{"type":"heartbeat","rand":42,"ts":1711800000}
```

Build and run on Linux:

```bash
make
./dummy_server
```

Build and run on Windows (MinGW):

```bat
make -f Makefile.win
dummy_server.exe
```

Runtime notes:

- `node` must be available on your `PATH`
- Optional override: set `NODE_BIN` to point to a specific Node executable
- Example override on Linux: `NODE_BIN=/usr/bin/node ./dummy_server`

Clean build artifacts:

```bash
make clean
make -f Makefile.win clean
```

# Possible forking structure when running the tty console in embedding mode.

There are two levels where the tty console can be run:

- node modules/base/packages/server_console/tty/index.js (in embedding mode)
- node ./apiServer.js (in actual console mode)

These two levels are independent and can be run separately, but when running the tty console in embedding mode, the forking structure looks like this:

```
tmux
 \_ -bash
     \_ /bin/bash ./respawn.sh
         \_ npm start
             \_ sh -c node modules/base/packages/server_console/tty/index.js
                 \_ node modules/base/packages/server_console/tty/index.js
                     \_ /home/user/server/pu/game-server
                         \_ node ./apiServer.js
```

In this example, the main process is a bash shell that runs `./respawn.sh`, which in turn runs `npm start`, which then runs the tty console in embedding mode. The tty console then spawns a child process that runs `node ./apiServer.js`, which is the actual console mode.

# Simplified

```
npm start
 \_ node modules/base/packages/server_console/tty/index.js
     \_ /home/user/server/pu/game-server
         \_ node ./apiServer.js
```

- `node modules/base/packages/server_console/tty/index.js`

After reading the config and finding the value `embeddingExecutable` being set, the tty console spawns a child process that runs the specified executable. It then reads stdout and stderr from the binary process and prints it in the console, while also saving it to a log file. It also listens for user input in the console and sends it to the binary process.

- `/home/user/server/pu/game-server`

The actual binary process that runs the game server. It will embed the actual tty console running inside the actual game server environment (in our example via `node ./apiServer.js`). The tty console running inside the game server binary simply tails the log file that the tty console in embedding mode writes to for display and logging purposes.

This is unavoidable if the tty console runs inside a binary process that embeds Node.js and we still want to catch all stdout and stderr output from the binary process and print it in the console. If we ran the tty console directly in the binary process, we would not be able to catch the output from the binary process and print it in the console nor save it to a log. By running the tty console in a separate process, we can catch all output from the binary process and print it in the console, while still allowing the binary process to run independently.
