#!/bin/sh
# Pull the latest livewire, rebuild, reinstall, restart.
printf '\033[1;36m== Updating livewire ==\033[0m\n\n'
cd "$(dirname "$0")"

if git pull --ff-only origin main && ./install.sh; then
	printf '\n\033[1;32mUpdate complete.\033[0m Restarting livewire…\n'
	pkill -x livewire 2>/dev/null
	sleep 1
	setsid "$HOME/.local/bin/livewire" >/dev/null 2>&1 &
	exit 0
fi

printf '\n\033[1;31mUpdate failed.\033[0m See the output above; the installed version is unchanged.\n'
exit 1
