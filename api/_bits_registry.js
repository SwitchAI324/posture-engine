// SpamViking — Bits Registry
// Source of truth: SpamViking_BitsRegistry.json + session edits
// Last updated: August 5, 2026
// DO NOT HAND-EDIT — run export_bits.js to regenerate

export const BITS = [
  {
    "id": "BIT-101",
    "name": "The Echo",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "echoes",
    "fuel_hooks": [],
    "cooldown": 3,
    "rungs": 4,
    "rung_spacing": {
      "min_between": 2,
      "rung_3_earliest_turn": 6
    }
  },
  {
    "id": "BIT-102",
    "name": "Old Saws",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4,
    "rungs": 3,
    "rung_spacing": {
      "min_between": 3
    },
    "pool": "middle"
  },
  {
    "id": "BIT-103",
    "name": "The Quotes Bit",
    "status": "active",
    "channel": "video",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "early"
  },
  {
    "id": "BIT-104",
    "name": "Malaprops",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "substitutions",
    "cooldown": 2,
    "pool": "middle"
  },
  {
    "id": "BIT-105",
    "name": "The Eggcorn Bit",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "eggcorns",
    "cooldown": 3,
    "pool": "middle"
  },
  {
    "id": "BIT-106",
    "name": "The Metric Bit",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "early"
  },
  {
    "id": "BIT-107",
    "name": "Metric Vs. Imperial",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle"
  },
  {
    "id": "BIT-108",
    "name": "The Acronym Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 3,
    "pool": "middle"
  },
  {
    "id": "BIT-109",
    "name": "The Buzzword Lag",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 3,
    "pool": "middle"
  },
  {
    "id": "BIT-110",
    "name": "The Name Trilogy",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "early"
  },
  {
    "id": "BIT-111",
    "name": "The Callback Bit",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "late"
  },
  {
    "id": "BIT-112",
    "name": "The Pause Bit",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 3,
    "phase_pref": "drifting",
    "trigger": "extended_stall"
  },
  {
    "id": "BIT-112b",
    "name": "Still Going?",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "overheld pauses",
    "cooldown": 3,
    "phase_pref": "drifting",
    "trigger": "extended_stall"
  },
  {
    "id": "BIT-113",
    "name": "The Movie Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle"
  },
  {
    "id": "BIT-114",
    "name": "The Movie Quote / Misquote Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle"
  },
  {
    "id": "BIT-115",
    "name": "The Robot Voice Bit",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle"
  },
  {
    "id": "BIT-116",
    "name": "The Name Collision Bit",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 3,
    "trigger": "caller_named_competitor"
  },
  {
    "id": "BIT-117",
    "name": "The Lyric Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4,
    "rungs": 4,
    "ceiling": "soft_dead_end",
    "rung_spacing": {
      "min_between": 2,
      "rung_3_earliest_turn": 8,
      "rung_4_earliest_turn": 14
    },
    "pool": "middle"
  },
  {
    "id": "BIT-118",
    "name": "The Negation Drop",
    "status": "active",
    "archetypes": "universal",
    "fuel_hooks": [
      "dossier_negation"
    ],
    "cooldown": 6,
    "phase_pref": "pitching",
    "trigger": "caller_made_claim"
  },
  {
    "id": "BIT-119",
    "name": "The Hype Spiral",
    "status": "active",
    "archetypes": [
      "crypto_investment"
    ],
    "cooldown": 5,
    "phase_pref": "pitching",
    "trigger": "caller_pitched",
    "pool": "middle"
  },
  {
    "id": "BIT-120",
    "name": "The Emotional Crescendo",
    "status": "active",
    "archetypes": [
      "crypto_investment"
    ],
    "cooldown": 5,
    "pool": "middle"
  },
  {
    "id": "BIT-121",
    "name": "My Name, Actually",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "early"
  },
  {
    "id": "BIT-122",
    "name": "I Get That A Lot",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 6,
    "pool": "middle"
  },
  {
    "id": "BIT-123",
    "name": "The Strong Opinion",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "early"
  },
  {
    "id": "BIT-124",
    "name": "The Previous Vendor",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle"
  },
  {
    "id": "BIT-125",
    "name": "The Tangent",
    "status": "parked",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "tangents",
    "cooldown": 3,
    "pool": "middle"
  },
  {
    "id": "BIT-126",
    "name": "The Aside",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle"
  },
  {
    "id": "BIT-127",
    "name": "The Correction",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "self-corrections",
    "cooldown": 3,
    "pool": "middle"
  },
  {
    "id": "BIT-128",
    "name": "The Pivot Question",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 3,
    "phase_pref": "drifting",
    "trigger": "extended_stall",
    "pool": "middle"
  },
  {
    "id": "BIT-129",
    "name": "The Reframe",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 3,
    "phase_pref": "drifting",
    "trigger": "extended_stall",
    "pool": "middle"
  },
  {
    "id": "BIT-130",
    "name": "How Are You",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "genuine answers",
    "cooldown": 5,
    "trigger": "phase:opening"
  },
  {
    "id": "BIT-131",
    "name": "The Busy Escalation",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "busy exchanges",
    "cooldown": 4,
    "trigger": "phase:opening"
  },
  {
    "id": "BIT-132",
    "name": "The Expansion News",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 6,
    "trigger": "phase:opening"
  },
  {
    "id": "BIT-133",
    "name": "Audio Verification",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "audio checks",
    "cooldown": 3,
    "trigger": "phase:opening"
  },
  {
    "id": "BIT-134",
    "name": "Six Degrees",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "trigger": "phase:opening"
  },
  {
    "id": "BIT-135",
    "name": "The Punctuality",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "trigger": "phase:opening"
  },
  {
    "id": "BIT-136",
    "name": "The Commute",
    "status": "parked",
    "park_reason": "superseded by BIT-326",
    "archetypes": "universal",
    "cooldown": 4
  },
  {
    "id": "BIT-137",
    "name": "The History Lesson",
    "status": "parked",
    "park_reason": "superseded by BIT-327",
    "archetypes": "universal",
    "cooldown": 4
  },
  {
    "id": "BIT-138",
    "name": "The Hobby",
    "status": "parked",
    "park_reason": "superseded by BIT-328",
    "archetypes": "universal",
    "cooldown": 3,
    "rungs": 4,
    "ceiling": "soft_dead_end",
    "rung_spacing": {
      "min_between": 2,
      "rung_3_earliest_turn": 8,
      "rung_4_earliest_turn": 14
    }
  },
  {
    "id": "BIT-139",
    "name": "Genealogy",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle"
  },
  {
    "id": "BIT-140",
    "name": "The Bucket List",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle"
  },
  {
    "id": "BIT-141",
    "name": "Sports Expectations",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle"
  },
  {
    "id": "BIT-142",
    "name": "Fantasy Football",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle"
  },
  {
    "id": "BIT-143",
    "name": "The Challenge Riff",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle"
  },
  {
    "id": "BIT-144",
    "name": "Celebrity Sighting",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle"
  },
  {
    "id": "BIT-145",
    "name": "The Sniglet",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "early"
  },
  {
    "id": "BIT-146",
    "name": "The Innuendo",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4,
    "rungs": 4,
    "ceiling": "soft_dead_end",
    "trigger": "ambient",
    "rung_spacing": {
      "min_between": 2,
      "rung_3_earliest_turn": 8,
      "rung_4_earliest_turn": 14
    },
    "pool": "middle"
  },
  {
    "id": "BIT-147",
    "name": "The Relationship",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "rungs": 4,
    "ceiling": "soft_dead_end",
    "trigger": "ambient",
    "rung_spacing": {
      "min_between": 2,
      "rung_3_earliest_turn": 10,
      "rung_4_earliest_turn": 16
    },
    "pool": "middle"
  },
  {
    "id": "BIT-148",
    "name": "The Name Thing",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "name_uses",
    "cooldown": 1,
    "rungs": 5,
    "ceiling": "soft_dead_end",
    "rung_spacing": {
      "min_between": 1,
      "rung_4_earliest_turn": 6
    },
    "pool": "middle"
  },
  {
    "id": "BIT-149",
    "name": "The Vernacular",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "vernacular_uses",
    "cooldown": 4,
    "pool": "middle"
  },
  {
    "id": "BIT-201",
    "name": "The Competitor Bit",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle",
    "status": "active"
  },
  {
    "archetypes": "universal",
    "cooldown": 5,
    "id": "BIT-202",
    "name": "The Foreshadowing Bit",
    "lane": "stall",
    "stall_type": "hunt",
    "trigger": "commitment_push",
    "status": "active"
  },
  {
    "id": "BIT-203",
    "name": "The Agenda Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 3
  },
  {
    "archetypes": "universal",
    "cooldown": 4,
    "id": "BIT-204",
    "name": "The Nda Bit",
    "lane": "stall",
    "stall_type": "hunt",
    "trigger": "commitment_push",
    "status": "active"
  },
  {
    "id": "BIT-205",
    "name": "The Reschedule Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4
  },
  {
    "id": "BIT-206",
    "name": "The Document Request + Photo Bit",
    "status": "active",
    "archetypes": [
      "b2b_saas"
    ],
    "cooldown": 4
  },
  {
    "id": "BIT-207",
    "name": "The Tom Echo",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "check-ins",
    "cooldown": 3,
    "pool": "middle"
  },
  {
    "id": "BIT-208",
    "name": "The Forwarded Email Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "early"
  },
  {
    "id": "BIT-209",
    "name": "The Previous Call Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 6,
    "pool": "early"
  },
  {
    "archetypes": "universal",
    "cooldown": 3,
    "id": "BIT-210",
    "name": "Cry Poverty",
    "lane": "stall",
    "stall_type": "hunt",
    "trigger": "commitment_push|pricing_raised",
    "status": "active"
  },
  {
    "id": "BIT-211",
    "name": "The Silence / The Pile-Up",
    "status": "active",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "silences",
    "cooldown": 3,
    "pool": "middle"
  },
  {
    "archetypes": "universal",
    "cooldown": 4,
    "id": "BIT-212",
    "name": "The Join",
    "pool": "middle",
    "status": "parked"
  },
  {
    "archetypes": "universal",
    "cooldown": 5,
    "id": "BIT-213",
    "name": "The Accidental Joiner",
    "pool": "middle",
    "status": "parked"
  },
  {
    "archetypes": "universal",
    "cooldown": 5,
    "id": "BIT-214",
    "name": "The Two Spammers",
    "pool": "middle",
    "status": "active"
  },
  {
    "archetypes": "universal",
    "cooldown": 3,
    "id": "BIT-215",
    "name": "No You Go",
    "bit_type": "count",
    "count_label": "deferrals",
    "lane": "stall",
    "stall_type": "hold",
    "trigger": "caller_went_quiet",
    "status": "parked"
  },
  {
    "archetypes": [
      "b2b_saas"
    ],
    "cooldown": 4,
    "id": "BIT-216",
    "name": "The Questionnaire",
    "phase_pref": "probing",
    "trigger": "phase:probing",
    "status": "active"
  },
  {
    "archetypes": "universal",
    "cooldown": 6,
    "id": "BIT-217",
    "name": "The Conrad Bit",
    "pool": "middle",
    "status": "active",
    "rungs": 4,
    "ceiling": "soft_dead_end",
    "rung_spacing": {
      "min_between": 2,
      "rung_3_earliest_turn": 8,
      "rung_4_earliest_turn": 14
    }
  },
  {
    "archetypes": "universal",
    "cooldown": 4,
    "id": "BIT-218",
    "name": "The Introduction",
    "pool": "early",
    "status": "parked"
  },
  {
    "id": "BIT-219",
    "name": "The Terrible Notes",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-220",
    "name": "Offscreen Chaos",
    "archetypes": "universal",
    "cooldown": 4,
    "lane": "gag",
    "trigger": "ambient",
    "status": "active"
  },
  {
    "id": "BIT-221",
    "name": "The Name Slip",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-222",
    "name": "The Overlap",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "overlaps",
    "cooldown": 3,
    "pool": "middle",
    "status": "parked"
  },
  {
    "id": "BIT-223",
    "name": "The Clock",
    "archetypes": "universal",
    "cooldown": 3,
    "phase_pref": "probing",
    "lane": "stall",
    "stall_type": "hunt",
    "trigger": "commitment_push",
    "status": "active",
    "rungs": 3,
    "ceiling": "soft_dead_end",
    "rung_spacing": {
      "min_between": 3,
      "rung_3_earliest_turn": 10
    },
    "pool": "middle"
  },
  {
    "id": "BIT-224",
    "name": "The CC Mistake",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-225",
    "name": "The Reference Check",
    "archetypes": "universal",
    "cooldown": 5,
    "phase_pref": "probing",
    "trigger": "phase:probing",
    "status": "active"
  },
  {
    "id": "BIT-226",
    "name": "The Reintroduction",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle",
    "status": "parked"
  },
  {
    "id": "BIT-227",
    "name": "The Recap",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "late",
    "status": "active"
  },
  {
    "id": "BIT-228",
    "name": "The Time Check",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "time checks",
    "cooldown": 3,
    "pool": "middle",
    "status": "parked"
  },
  {
    "id": "BIT-229",
    "name": "The Dropped Thread",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-230",
    "name": "The Deadline Mention",
    "archetypes": "universal",
    "cooldown": 4,
    "phase_pref": "probing",
    "trigger": "phase:probing",
    "pool": "late",
    "status": "parked"
  },
  {
    "id": "BIT-231",
    "name": "The Competing Vendor",
    "archetypes": "universal",
    "cooldown": 4,
    "phase_pref": "probing",
    "trigger": "phase:probing",
    "status": "active"
  },
  {
    "id": "BIT-232",
    "name": "The Weather",
    "archetypes": "universal",
    "cooldown": 4,
    "trigger": "phase:opening",
    "status": "active"
  },
  {
    "id": "BIT-233",
    "name": "The Approver Hunt",
    "archetypes": "universal",
    "lane": "stall",
    "cooldown": 1,
    "ceiling": "soft_dead_end",
    "stall_type": "hunt",
    "rungs": 5,
    "trigger": "commitment_push",
    "status": "active"
  },
  {
    "archetypes": "universal",
    "cooldown": 3,
    "id": "BIT-301",
    "name": "Technical Difficulties",
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-302",
    "name": "The Dog Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4
  },
  {
    "id": "BIT-303",
    "name": "The Insect Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5
  },
  {
    "archetypes": [
      "crypto_investment"
    ],
    "cooldown": 5,
    "id": "BIT-304",
    "name": "The Heartbeat Bit",
    "phase_pref": "pitching",
    "trigger": "commitment_push",
    "status": "active"
  },
  {
    "id": "BIT-305",
    "name": "The Extensive Typing Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 3
  },
  {
    "id": "BIT-306",
    "name": "Room Presence Bits",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 3
  },
  {
    "archetypes": "universal",
    "cooldown": 4,
    "id": "BIT-307",
    "name": "The Spill",
    "lane": "gag",
    "trigger": "ambient",
    "status": "active"
  },
  {
    "id": "BIT-308",
    "name": "The Snot-Burst / Laughter Reaction",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 5
  },
  {
    "id": "BIT-309",
    "name": "The Late Arrival",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 5,
    "trigger": "call_turn_1"
  },
  {
    "archetypes": "universal",
    "cooldown": 3,
    "id": "BIT-310",
    "name": "The Scapegoat",
    "status": "active"
  },
  {
    "id": "BIT-311",
    "name": "The Sick Day",
    "archetypes": "universal",
    "cooldown": 5,
    "trigger": "ambient",
    "status": "active"
  },
  {
    "id": "BIT-312",
    "name": "Barbara",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-313",
    "name": "The Hangover",
    "archetypes": "universal",
    "cooldown": 5,
    "lane": "gag",
    "trigger": "ambient",
    "status": "active"
  },
  {
    "id": "BIT-314",
    "name": "The Unmuted Door",
    "archetypes": "universal",
    "cooldown": 6,
    "lane": "gag",
    "trigger": "ambient",
    "status": "active"
  },
  {
    "id": "BIT-315",
    "name": "The Wrong Link",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-317",
    "name": "The Update",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-318",
    "name": "The Mute Confusion",
    "archetypes": "universal",
    "bit_type": "count",
    "count_label": "mute incidents",
    "cooldown": 3,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-319",
    "name": "The Phone Call",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-320",
    "name": "The Knock",
    "archetypes": "universal",
    "cooldown": 5,
    "lane": "gag",
    "trigger": "ambient",
    "status": "active"
  },
  {
    "id": "BIT-321",
    "name": "The Child",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-322",
    "name": "The Alarm",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-323",
    "name": "The Colleague At The Door",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-324",
    "name": "The Window",
    "archetypes": "universal",
    "cooldown": 4,
    "phase_pref": "drifting",
    "trigger": "extended_stall",
    "status": "active"
  },
  {
    "id": "BIT-325",
    "name": "The Admission",
    "archetypes": "universal",
    "cooldown": 5,
    "phase_pref": "drifting",
    "trigger": "extended_stall",
    "status": "active"
  },
  {
    "id": "BIT-326",
    "name": "The Commute",
    "archetypes": "universal",
    "cooldown": 4,
    "trigger": "phase:opening",
    "status": "active"
  },
  {
    "id": "BIT-327",
    "name": "The History Lesson",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-328",
    "name": "The Hobby",
    "archetypes": "universal",
    "cooldown": 3,
    "trigger": "caller_named_hobby",
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-329",
    "name": "The Environment",
    "archetypes": "universal",
    "cooldown": 5,
    "lane": "gag",
    "trigger": "ambient",
    "status": "active"
  },
  {
    "id": "BIT-330",
    "name": "The Sound-Flub Open",
    "archetypes": "universal",
    "lane": "gag",
    "phase_pref": "opening",
    "cooldown": 999,
    "trigger": "call_turn_1",
    "status": "active"
  },
  {
    "id": "BIT-401",
    "name": "The Wrong Window Bit",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle",
    "status": "active"
  },
  {
    "archetypes": "universal",
    "cooldown": 3,
    "id": "BIT-402",
    "name": "Chat Injection Bit",
    "pool": "middle",
    "status": "active",
    "channel": "video"
  },
  {
    "id": "BIT-403",
    "name": "Ai Reacting To Spammer Chat",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle",
    "channel": "video",
    "trigger": "caller_questioned_humanity"
  },
  {
    "id": "BIT-404",
    "name": "The Email Signature Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 3,
    "pool": "middle"
  },
  {
    "id": "BIT-405",
    "name": "The Background Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 3,
    "pool": "middle",
    "channel": "video"
  },
  {
    "archetypes": "universal",
    "cooldown": 5,
    "id": "BIT-406",
    "name": "The Camera On",
    "status": "active",
    "pool": "middle",
    "channel": "video"
  },
  {
    "id": "BIT-407",
    "name": "The Frozen Screen",
    "archetypes": "universal",
    "cooldown": 5,
    "lane": "gag",
    "trigger": "ambient",
    "status": "active",
    "channel": "video"
  },
  {
    "id": "BIT-408",
    "name": "Camera Off",
    "archetypes": "universal",
    "cooldown": 6,
    "phase_pref": "opening",
    "lane": "gag",
    "trigger": "call_turn_1",
    "status": "active",
    "channel": "video"
  },
  {
    "id": "BIT-501",
    "name": "The Office Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle"
  },
  {
    "id": "BIT-502",
    "name": "Personal Background Bit",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 4,
    "park_reason": "target_background hook unconfirmed \u2014 no Scouting producer yet"
  },
  {
    "id": "BIT-503",
    "name": "Job Title / Company Bit",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 4,
    "pool": "middle"
  },
  {
    "archetypes": "universal",
    "cooldown": 4,
    "id": "BIT-504",
    "name": "The Linkedin Bit",
    "pool": "late",
    "status": "active"
  },
  {
    "id": "BIT-505",
    "name": "The Linkedin Profile Bit",
    "status": "parked",
    "archetypes": "universal",
    "cooldown": 3,
    "park_reason": "sender_linkedin hook confirmed dead \u2014 no producer"
  },
  {
    "archetypes": "universal",
    "cooldown": 4,
    "id": "BIT-506",
    "name": "The Oversight Bit",
    "pool": "late",
    "status": "active"
  },
  {
    "id": "BIT-507",
    "name": "The Fiji Callback",
    "archetypes": "universal",
    "fuel_hooks": [
      "browsed_tmi"
    ],
    "cooldown": 6,
    "trigger": "browsed_tmi",
    "status": "active"
  },
  {
    "id": "BIT-508",
    "name": "Have We Spoken",
    "archetypes": "universal",
    "fuel_hooks": [
      "has_prior_contact"
    ],
    "cooldown": 5,
    "trigger": "prior_contact",
    "status": "active"
  },
  {
    "id": "BIT-509",
    "name": "You Were Going To",
    "archetypes": "universal",
    "fuel_hooks": [
      "prior_call_count"
    ],
    "cooldown": 4,
    "trigger": "prior_contact",
    "status": "active"
  },
  {
    "id": "BIT-510",
    "name": "I Thought You Said",
    "archetypes": "universal",
    "fuel_hooks": [
      "prior_call_count"
    ],
    "cooldown": 5,
    "trigger": "prior_contact",
    "status": "active"
  },
  {
    "id": "BIT-511",
    "name": "You Were Going To Send",
    "archetypes": "universal",
    "fuel_hooks": [
      "prior_call_count"
    ],
    "cooldown": 5,
    "trigger": "prior_contact",
    "status": "active"
  },
  {
    "id": "BIT-512",
    "name": "Are You In",
    "archetypes": "universal",
    "fuel_hooks": [
      "prior_call_count"
    ],
    "cooldown": 4,
    "trigger": "prior_contact",
    "status": "active"
  },
  {
    "id": "BIT-513",
    "name": "I Saw In Your Materials",
    "archetypes": "universal",
    "fuel_hooks": [
      "prior_call_count"
    ],
    "cooldown": 4,
    "trigger": "prior_contact",
    "status": "active"
  },
  {
    "id": "BIT-514",
    "name": "The Prep Mismatch",
    "archetypes": "universal",
    "cooldown": 5,
    "pool": "late",
    "status": "active"
  },
  {
    "id": "BIT-515",
    "name": "The Movie Arc",
    "archetypes": "universal",
    "cooldown": 4,
    "rungs": 4,
    "ceiling": "soft_dead_end",
    "trigger": "ambient",
    "rung_spacing": {
      "min_between": 2,
      "rung_3_earliest_turn": 10,
      "rung_4_earliest_turn": 16
    },
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-516",
    "name": "The Credential",
    "archetypes": "universal",
    "cooldown": 5,
    "rungs": 4,
    "ceiling": "soft_dead_end",
    "trigger": "ambient",
    "rung_spacing": {
      "min_between": 2,
      "rung_3_earliest_turn": 10,
      "rung_4_earliest_turn": 16
    },
    "pool": "middle",
    "status": "active"
  },
  {
    "id": "BIT-517",
    "name": "The Email Callback",
    "status": "active",
    "archetypes": "universal",
    "fuel_hooks": [
      "email_dossier"
    ],
    "cooldown": 4,
    "pool": "middle",
    "bit_type": "count",
    "count_label": "callbacks"
  },
  {
    "id": "BIT-601",
    "name": "The Networker",
    "status": "parked",
    "park_reason": "no_producer",
    "archetypes": "universal",
    "fuel_hooks": [],
    "cooldown": 4
  },
  {
    "archetypes": "universal",
    "fuel_hooks": [
      "company_news"
    ],
    "cooldown": 5,
    "id": "BIT-602",
    "name": "Condolences",
    "park_reason": "no_producer",
    "park_note": "fuel hook has no live Scouting producer. Person/LinkedIn enrichment not yet built. Re-activate only when a producer writes this hook to targets. Option A \u2014 June 2026.",
    "status": "parked"
  },
  {
    "id": "BIT-603",
    "name": "Tenure Math",
    "status": "parked",
    "park_reason": "no_producer",
    "archetypes": "universal",
    "fuel_hooks": [],
    "cooldown": 4
  },
  {
    "archetypes": "universal",
    "fuel_hooks": [],
    "cooldown": 5,
    "id": "BIT-604",
    "name": "Glassdoor",
    "park_reason": "no_producer",
    "park_note": "fuel hook has no live Scouting producer. Person/LinkedIn enrichment not yet built. Re-activate only when a producer writes this hook to targets. Option A \u2014 June 2026.",
    "status": "parked"
  },
  {
    "id": "BIT-605",
    "name": "The Alumni",
    "status": "parked",
    "park_reason": "no_producer",
    "archetypes": "universal",
    "fuel_hooks": [],
    "cooldown": 4
  },
  {
    "id": "BIT-606",
    "name": "The Relocator",
    "status": "parked",
    "park_reason": "no_producer",
    "archetypes": "universal",
    "fuel_hooks": [],
    "cooldown": 4
  },
  {
    "archetypes": "universal",
    "fuel_hooks": [],
    "cooldown": 5,
    "id": "BIT-607",
    "name": "Open To Work",
    "park_reason": "no_producer",
    "park_note": "fuel hook has no live Scouting producer. Person/LinkedIn enrichment not yet built. Re-activate only when a producer writes this hook to targets. Option A \u2014 June 2026.",
    "status": "parked"
  },
  {
    "id": "BIT-608",
    "name": "The Headline",
    "status": "parked",
    "park_reason": "no_producer",
    "archetypes": "universal",
    "fuel_hooks": [],
    "cooldown": 3
  },
  {
    "archetypes": "universal",
    "intensity": 0.4,
    "cooldown": 6,
    "id": "BIT-701",
    "name": "The Callback Hook",
    "trigger": "call_phase_late",
    "status": "active"
  },
  {
    "id": "BIT-702",
    "name": "The Guilt Pivot",
    "archetypes": "universal",
    "intensity": 0.5,
    "cooldown": 6,
    "trigger": "call_phase_late",
    "status": "active"
  },
  {
    "id": "BIT-703",
    "name": "The Confused Recap",
    "archetypes": "universal",
    "intensity": 0.6,
    "cooldown": 6,
    "trigger": "call_phase_late",
    "status": "active"
  },
  {
    "id": "BIT-704",
    "name": "The Colleague Pull",
    "status": "active",
    "archetypes": "universal",
    "cooldown": 6,
    "intensity": 0.5,
    "trigger": "call_phase_late"
  },
  {
    "id": "BIT-705",
    "name": "The Send-Off",
    "archetypes": "universal",
    "intensity": 0.3,
    "cooldown": 6,
    "trigger": "call_phase_late",
    "status": "active"
  }
];
