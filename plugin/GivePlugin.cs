using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace GivePlugin;

// Admin command plugin for the CS2 web panel.
// All commands take a target: @all, @ct, @t, #<userid>, or a (partial) name.
public class GivePlugin : BasePlugin
{
    public override string ModuleName => "PanelAdmin";
    public override string ModuleVersion => "1.2.0";
    public override string ModuleAuthor => "panel";

    private readonly HashSet<uint> _god = new();

    public override void Load(bool hotReload)
    {
        // Keep god-mode players topped up
        AddTimer(0.3f, () =>
        {
            foreach (var p in Utilities.GetPlayers())
            {
                if (!_god.Contains(p.Index)) continue;
                var pawn = p.PlayerPawn?.Value;
                if (pawn != null && pawn.Health < 100000)
                {
                    pawn.Health = 100000;
                    Utilities.SetStateChanged(pawn, "CBaseEntity", "m_iHealth");
                }
            }
        }, TimerFlags.REPEAT);
    }

    private List<CCSPlayerController> Resolve(string target)
    {
        var players = Utilities.GetPlayers().Where(p => p.IsValid).ToList();
        if (target == "@all") return players;
        if (target == "@ct") return players.Where(p => p.Team == CsTeam.CounterTerrorist).ToList();
        if (target == "@t") return players.Where(p => p.Team == CsTeam.Terrorist).ToList();
        if (target.StartsWith("#") && int.TryParse(target.Substring(1), out var uid))
            return players.Where(p => p.UserId == uid).ToList();
        return players.Where(p => p.PlayerName.Contains(target, StringComparison.OrdinalIgnoreCase)).ToList();
    }

    [ConsoleCommand("css_give", "Give a weapon")]
    [CommandHelper(minArgs: 2, usage: "<target> <weapon>")]
    public void OnGive(CCSPlayerController? c, CommandInfo info)
    {
        var w = info.GetArg(2);
        if (!w.StartsWith("weapon_") && !w.StartsWith("item_")) w = "weapon_" + w;
        var n = 0;
        foreach (var p in Resolve(info.GetArg(1)).Where(p => p.PawnIsAlive)) { p.GiveNamedItem(w); n++; }
        info.ReplyToCommand($"[Admin] gave {w} to {n}");
    }

    [ConsoleCommand("css_hp", "Set health")]
    [CommandHelper(minArgs: 2, usage: "<target> <hp>")]
    public void OnHp(CCSPlayerController? c, CommandInfo info)
    {
        if (!int.TryParse(info.GetArg(2), out var hp)) return;
        var n = 0;
        foreach (var p in Resolve(info.GetArg(1)).Where(p => p.PawnIsAlive))
        {
            var pawn = p.PlayerPawn!.Value!;
            pawn.Health = hp; pawn.MaxHealth = Math.Max(hp, 100);
            Utilities.SetStateChanged(pawn, "CBaseEntity", "m_iHealth");
            n++;
        }
        info.ReplyToCommand($"[Admin] HP {hp} -> {n}");
    }

    [ConsoleCommand("css_armor", "Set armor")]
    [CommandHelper(minArgs: 2, usage: "<target> <armor>")]
    public void OnArmor(CCSPlayerController? c, CommandInfo info)
    {
        if (!int.TryParse(info.GetArg(2), out var ar)) return;
        var n = 0;
        foreach (var p in Resolve(info.GetArg(1)).Where(p => p.PawnIsAlive))
        {
            var pawn = p.PlayerPawn!.Value!;
            pawn.ArmorValue = ar;
            Utilities.SetStateChanged(pawn, "CCSPlayerPawn", "m_ArmorValue");
            n++;
        }
        info.ReplyToCommand($"[Admin] armor {ar} -> {n}");
    }

    [ConsoleCommand("css_god", "Toggle god mode")]
    [CommandHelper(minArgs: 1, usage: "<target>")]
    public void OnGod(CCSPlayerController? c, CommandInfo info)
    {
        var n = 0;
        foreach (var p in Resolve(info.GetArg(1)))
        {
            if (!_god.Remove(p.Index)) _god.Add(p.Index);
            n++;
        }
        info.ReplyToCommand($"[Admin] god toggled -> {n}");
    }

    [ConsoleCommand("css_slay", "Kill player")]
    [CommandHelper(minArgs: 1, usage: "<target>")]
    public void OnSlay(CCSPlayerController? c, CommandInfo info)
    {
        var n = 0;
        foreach (var p in Resolve(info.GetArg(1)).Where(p => p.PawnIsAlive)) { p.PlayerPawn!.Value!.CommitSuicide(false, true); n++; }
        info.ReplyToCommand($"[Admin] slayed {n}");
    }

    [ConsoleCommand("css_respawn", "Respawn player")]
    [CommandHelper(minArgs: 1, usage: "<target>")]
    public void OnRespawn(CCSPlayerController? c, CommandInfo info)
    {
        var n = 0;
        foreach (var p in Resolve(info.GetArg(1))) { p.Respawn(); n++; }
        info.ReplyToCommand($"[Admin] respawned {n}");
    }

    [ConsoleCommand("css_strip", "Strip weapons")]
    [CommandHelper(minArgs: 1, usage: "<target>")]
    public void OnStrip(CCSPlayerController? c, CommandInfo info)
    {
        var n = 0;
        foreach (var p in Resolve(info.GetArg(1)).Where(p => p.PawnIsAlive)) { p.RemoveWeapons(); n++; }
        info.ReplyToCommand($"[Admin] stripped {n}");
    }

    [ConsoleCommand("css_noclip", "Toggle noclip")]
    [CommandHelper(minArgs: 1, usage: "<target>")]
    public void OnNoclip(CCSPlayerController? c, CommandInfo info)
    {
        var n = 0;
        foreach (var p in Resolve(info.GetArg(1)).Where(p => p.PawnIsAlive))
        {
            var pawn = p.PlayerPawn!.Value!;
            pawn.MoveType = pawn.MoveType == MoveType_t.MOVETYPE_NOCLIP ? MoveType_t.MOVETYPE_WALK : MoveType_t.MOVETYPE_NOCLIP;
            Utilities.SetStateChanged(pawn, "CBaseEntity", "m_MoveType");
            n++;
        }
        info.ReplyToCommand($"[Admin] noclip -> {n}");
    }

    [ConsoleCommand("css_team", "Set team (ct/t/spec)")]
    [CommandHelper(minArgs: 2, usage: "<target> <ct/t/spec>")]
    public void OnTeam(CCSPlayerController? c, CommandInfo info)
    {
        var t = info.GetArg(2).ToLower();
        var team = t.StartsWith("ct") ? CsTeam.CounterTerrorist : t.StartsWith("t") ? CsTeam.Terrorist : CsTeam.Spectator;
        var n = 0;
        foreach (var p in Resolve(info.GetArg(1))) { p.ChangeTeam(team); n++; }
        info.ReplyToCommand($"[Admin] team {team} -> {n}");
    }
}
