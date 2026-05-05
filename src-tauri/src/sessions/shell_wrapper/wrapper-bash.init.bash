# Charminal wrapper rc (bash)
#
# bash --rcfile で読まれる init script。auto-generated; do not edit.
# ~/.charminal/shell/user.bash が user 拡張点。

# user の .bashrc を chain
if [ -f "$HOME/.bashrc" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.bashrc"
fi

# Charminal integration (OSC 133)
if [ -f "$HOME/.charminal/shell/init.bash" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.charminal/shell/init.bash"
fi

# user 拡張点
if [ -f "$HOME/.charminal/shell/user.bash" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.charminal/shell/user.bash"
fi
