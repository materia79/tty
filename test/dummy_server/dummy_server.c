#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

static volatile sig_atomic_t keep_running = 1;
#ifdef _WIN32
static volatile sig_atomic_t child_should_stop = 0;
static PROCESS_INFORMATION node_process = {0};
static int node_started = 0;
#else
static volatile sig_atomic_t child_should_stop = 0;
static pid_t node_pid = -1;
#endif

static void handle_signal(int sig)
{
	(void)sig;
	keep_running = 0;
	child_should_stop = 1;
}

static void sleep_seconds(unsigned int seconds)
{
#ifdef _WIN32
	Sleep(seconds * 1000U);
#else
	while (seconds > 0U) {
		seconds = sleep(seconds);
	}
#endif
}

#ifdef _WIN32
static BOOL WINAPI console_ctrl_handler(DWORD ctrl_type)
{
	if (ctrl_type == CTRL_C_EVENT || ctrl_type == CTRL_BREAK_EVENT || ctrl_type == CTRL_CLOSE_EVENT) {
		keep_running = 0;
		child_should_stop = 1;
		return TRUE;
	}

	return FALSE;
}

static int start_node_child(void)
{
	STARTUPINFOA si;
	char command_line[1024];
	const char *node_bin = getenv("NODE_BIN");
	const char *bootstrap_path = "bin\\dummy_bootstrap.js";

	if (!node_bin || node_bin[0] == '\0') {
		node_bin = "node";
	}

	ZeroMemory(&si, sizeof(si));
	ZeroMemory(&node_process, sizeof(node_process));
	si.cb = sizeof(si);

	if (_snprintf(command_line, sizeof(command_line), "\"%s\" \"%s\"", node_bin, bootstrap_path) < 0) {
		fprintf(stderr, "failed to build node command line\n");
		return 0;
	}

	if (!CreateProcessA(
			NULL,
			command_line,
			NULL,
			NULL,
			FALSE,
			0,
			NULL,
			NULL,
			&si,
			&node_process)) {
		fprintf(stderr, "failed to spawn node child (error=%lu)\n", (unsigned long)GetLastError());
		return 0;
	}

	node_started = 1;
	return 1;
}

static int child_is_running(void)
{
	DWORD exit_code = 0;

	if (!node_started) {
		return 0;
	}

	if (!GetExitCodeProcess(node_process.hProcess, &exit_code)) {
		fprintf(stderr, "failed to query child exit code (error=%lu)\n", (unsigned long)GetLastError());
		return 0;
	}

	if (exit_code == STILL_ACTIVE) {
		return 1;
	}

	fprintf(stderr, "node child exited with code %lu\n", (unsigned long)exit_code);
	node_started = 0;
	return 0;
}

static void stop_node_child(void)
{
	if (!node_started) {
		return;
	}

	TerminateProcess(node_process.hProcess, 0);
	WaitForSingleObject(node_process.hProcess, 5000);
	CloseHandle(node_process.hThread);
	CloseHandle(node_process.hProcess);
	node_started = 0;
}

#else

static int start_node_child(void)
{
	const char *node_bin = getenv("NODE_BIN");
	char *const argv[] = {
		(char *)(node_bin && node_bin[0] != '\0' ? node_bin : "node"),
		"bin/dummy_bootstrap.js",
		NULL
	};

	node_pid = fork();
	if (node_pid < 0) {
		perror("fork failed");
		return 0;
	}

	if (node_pid == 0) {
		execvp(argv[0], argv);
		perror("execvp(node) failed");
		_exit(127);
	}

	return 1;
}

static int child_is_running(void)
{
	int status = 0;
	pid_t result;

	if (node_pid <= 0) {
		return 0;
	}

	result = waitpid(node_pid, &status, WNOHANG);
	if (result == 0) {
		return 1;
	}

	if (result == node_pid) {
		if (WIFEXITED(status)) {
			fprintf(stderr, "node child exited with code %d\n", WEXITSTATUS(status));
		} else if (WIFSIGNALED(status)) {
			fprintf(stderr, "node child terminated by signal %d\n", WTERMSIG(status));
		}
		node_pid = -1;
		return 0;
	}

	perror("waitpid failed");
	return 0;
}

static void stop_node_child(void)
{
	int status = 0;
	int attempts;

	if (node_pid <= 0) {
		return;
	}

	kill(node_pid, SIGTERM);
	for (attempts = 0; attempts < 5; ++attempts) {
		if (waitpid(node_pid, &status, WNOHANG) == node_pid) {
			node_pid = -1;
			return;
		}
		sleep_seconds(1);
	}

	kill(node_pid, SIGKILL);
	waitpid(node_pid, &status, 0);
	node_pid = -1;
}
#endif

int main(void)
{
	unsigned int seed = (unsigned int)time(NULL);
	int exit_code = 0;

	signal(SIGINT, handle_signal);
	signal(SIGTERM, handle_signal);
#ifdef _WIN32
	SetConsoleCtrlHandler(console_ctrl_handler, TRUE);
#endif

	srand(seed);
	if (!start_node_child()) {
		return 1;
	}

	fprintf(stderr, "dummy_server started (JSON heartbeat every 5 seconds, node child active)\n");

	while (keep_running) {
		unsigned int i;
		int value = rand() % 100;
		long long ts = (long long)time(NULL);

		if (!child_is_running()) {
			fprintf(stderr, "node child is not running, exiting fail-fast\n");
			exit_code = 1;
			break;
		}

		printf("{\"type\":\"heartbeat\",\"rand\":%d,\"ts\":%lld}\n", value, ts);
		fflush(stdout);

		for (i = 0; i < 5 && keep_running; ++i) {
			sleep_seconds(1);
			if (!child_is_running()) {
				fprintf(stderr, "node child exited unexpectedly, shutting down\n");
				exit_code = 1;
				keep_running = 0;
				break;
			}
		}
	}

	if (child_should_stop || exit_code != 0) {
		stop_node_child();
	}

	fprintf(stderr, "dummy_server stopped\n");
	return exit_code;
}
