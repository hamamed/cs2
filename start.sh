#!/bin/bash
# Sourced settings are managed by the web panel (server-vars.conf)
source /home/steam/cs2_server/server-vars.conf

export LD_LIBRARY_PATH=/home/steam/cs2_server/game/bin/linuxsteamrt64:$LD_LIBRARY_PATH
cd /home/steam/cs2_server/game/bin/linuxsteamrt64

# If a Workshop map ID is set, boot on it (custom mode, no cooldown). Otherwise use the normal map.
if [ -n "$WORKSHOP" ]; then
  MAPARG="+host_workshop_map $WORKSHOP"
else
  MAPARG="+map $MAP"
fi

./cs2 -dedicated -console -usercon \
  +game_type "$GAME_TYPE" +game_mode "$GAME_MODE" $MAPARG \
  +sv_setsteamaccount "$GSLT" \
  -port "$PORT" +sv_lan 0 \
  +sv_password "$SV_PW" \
  +rcon_password "$RCON_PW" \
  +sv_kick_players_with_cooldown 0 \
  +exec server.cfg
