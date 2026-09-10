// ---------------------------------------------------------------
// BKK SHARED SERVER -- Cloudflare Workers + Durable Objects version.
//
// This is a port of bkk_server.js (originally a plain Node.js server
// on Render) onto Cloudflare's own compute platform. The business
// logic below (constants, helpers, the `actions` object) is carried
// over essentially unchanged from that version -- it's pure JS
// operating on a `state` object, so none of it needed to change.
//
// What's genuinely different:
// - No traditional "server" process. A Durable Object holds the one
//   shared `state` in memory and handles requests one at a time,
//   which is what keeps this safe from race conditions the same way
//   the old single-process Node server was.
// - Persistence uses the Durable Object's own built-in storage
//   instead of a local file or a separate KV REST call -- simpler,
//   and it's the natively "right" way to persist state for a DO.
// - HTTP handling uses the Workers Request/Response API instead of
//   Node's http module, since that's what's available here.
// ---------------------------------------------------------------

const webpush = require("web-push");

// ---------------------------------------------------------------
// CONSTANTS -- unchanged from bkk_server.js.
// ---------------------------------------------------------------
const VEHICLES = ["BKK31", "BKK32", "BKK33", "BKK36", "BKK37", "BKK44", "BKK56", "SES59", "SES43K", "BKK-FEIGE", "BKK-ALLPORT", "BKK-OFEIGE"];

const STATUSES = [
  { id: "standby", label: "STANDBY", led: "#7C8791" },
  { id: "onalert", label: "ON ALERT", led: "#E8B23C" },
  { id: "activated", label: "ACTIVATED", led: "#3FA34D" },
  { id: "rest", label: "REST", led: "#2F8FD1" },
  { id: "stooddown", label: "STOOD DOWN", led: "#D9463D" },
];
const STATUS_BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

const REJECT_REASONS = ["Asset N/A", "Team N/A", "Wrong Unit", "Other"];
const CANCEL_REASONS = ["Created in error", "Duplicate", "No longer required", "Not an SES task", "Other"];

const SUBURBS = [
  "Bankstown", "Chullora", "Greenacre", "Mount Lewis", "Punchbowl",
  "Bass Hill", "Birrong", "Chester Hill", "Condell Park", "Georges Hall",
  "Lansdowne", "Potts Hill", "Regents Park", "Sefton", "Villawood", "Yagoona",
  "East Hills", "Milperra", "Padstow", "Padstow Heights", "Panania",
  "Picnic Point", "Revesby", "Revesby Heights",
];

function findSuburbForAddress(addr) {
  if (!addr) return null;
  const upper = addr.toUpperCase();
  const sorted = [...SUBURBS].sort((a, b) => b.length - a.length);
  return sorted.find((s) => upper.includes(s.toUpperCase())) || null;
}

function pad4(n) { return String(n).padStart(4, "0"); }

// ---------------------------------------------------------------
// STATE SHAPE -- unchanged from bkk_server.js.
// ---------------------------------------------------------------
function initialVehicleState() {
  return {
    queue: [],
    activeJob: null,
    incomingQueue: [],
    teamStatus: STATUSES[0],
    timeline: [{ id: `seed-${Date.now()}-${Math.random()}`, main: "Vehicle initialised", time: new Date().toISOString() }],
    crew: [],
    leaderId: null,
    progress: {},
  };
}

function initialState() {
  const vehicleStates = {};
  VEHICLES.forEach((v) => { vehicleStates[v] = initialVehicleState(); });
  return {
    vehicleStates,
    autoRequestNearestAsset: true,
    suburbAssignments: {},
    completedJobs: [],
    calledOffJobs: [],
    allIncidents: [],
    unassignedIncidents: [],
    incidentNotes: {},
    incidentTimelines: {},
    pushSubscriptions: {},
    incidentCounter: 1,
    ssMembers: [],
    externalPeople: [],
  };
}

// ---------------------------------------------------------------
// DURABLE OBJECT -- one single instance holds the whole shared
// `state`, same role the module-level `state` variable played in the
// old Node server. `data` below stands in for that.
// ---------------------------------------------------------------
export class BkkState {
  constructor(ctrl, env) {
    this.ctrl = ctrl;
    this.env = env;
    this.data = null;
    this.vapidReady = false;
    // Durable Objects can receive a request before the constructor's
    // async work finishes -- blockConcurrencyWhile makes sure every
    // request waits for this load to complete first, so nothing ever
    // sees a half-initialized state.
    ctrl.blockConcurrencyWhile(async () => {
      const stored = await this.ctrl.storage.get("state");
      this.data = stored ? { ...initialState(), ...stored } : initialState();
      VEHICLES.forEach((v) => {
        if (!this.data.vehicleStates[v]) this.data.vehicleStates[v] = initialVehicleState();
      });
    });
  }

  ensureVapid() {
    if (this.vapidReady) return;
    const pub = this.env.VAPID_PUBLIC_KEY;
    const priv = this.env.VAPID_PRIVATE_KEY;
    if (pub && priv) {
      webpush.setVapidDetails("mailto:admin@bankstownses.com", pub, priv);
      this.vapidReady = true;
    }
  }

  async save() {
    await this.ctrl.storage.put("state", this.data);
  }

  // ---------------------------------------------------------------
  // HELPERS -- same behaviour as bkk_server.js, now referencing
  // `this.data` instead of a module-level `state` variable.
  // ---------------------------------------------------------------
  shortId(id) { return String(id).replace(/^Incident /, ""); }

  logEventFor(vehicle, main) {
    if (!this.data.vehicleStates[vehicle]) return;
    this.data.vehicleStates[vehicle].timeline.unshift({
      id: `${Date.now()}-${Math.random()}`, main, time: new Date().toISOString(),
    });
  }

  pickNearestEligibleVehicle() {
    const eligible = VEHICLES.filter((v) => this.data.vehicleStates[v].teamStatus.id !== "stooddown");
    if (eligible.length === 0) return null;
    let best = null, bestDist = Infinity;
    eligible.forEach((v) => {
      const d = Math.random() * 9 + 1;
      if (d < bestDist) { bestDist = d; best = v; }
    });
    return { vehicle: best, dist: bestDist.toFixed(1) };
  }

  resolveAutoVehicle(addr) {
    const suburb = findSuburbForAddress(addr);
    if (suburb && this.data.suburbAssignments[suburb]) {
      const assigned = this.data.suburbAssignments[suburb];
      if (this.data.vehicleStates[assigned] && this.data.vehicleStates[assigned].teamStatus.id !== "stooddown") {
        return { vehicle: assigned, reason: "suburb", suburb };
      }
    }
    if (this.data.autoRequestNearestAsset) {
      const nearest = this.pickNearestEligibleVehicle();
      if (nearest) return { vehicle: nearest.vehicle, reason: "nearest" };
    }
    return null;
  }

  updateIncidentEverywhere(incidentId, updater) {
    this.data.allIncidents = this.data.allIncidents.map((i) => (i.id === incidentId ? updater(i) : i));
    this.data.unassignedIncidents = this.data.unassignedIncidents.map((i) => (i.id === incidentId ? updater(i) : i));
    VEHICLES.forEach((v) => {
      const vs = this.data.vehicleStates[v];
      if (!vs) return;
      vs.queue = vs.queue.map((i) => (i.id === incidentId ? updater(i) : i));
      vs.incomingQueue = vs.incomingQueue.map((i) => (i.id === incidentId ? updater(i) : i));
    });
  }

  addIncidentTimelineEntry(incidentId, status, note, timestamp) {
    if (!this.data.incidentTimelines[incidentId]) this.data.incidentTimelines[incidentId] = [];
    this.data.incidentTimelines[incidentId].unshift({
      id: `${Date.now()}-${Math.random()}`,
      status, note: note || null,
      time: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
    });
  }

  setIncidentStatus(incidentId, status, note, timestamp) {
    this.updateIncidentEverywhere(incidentId, (i) => ({ ...i, status }));
    this.addIncidentTimelineEntry(incidentId, status, note, timestamp);
  }

  sendPushToVehicle(vehicle, payload) {
    this.ensureVapid();
    if (!this.vapidReady) return;
    const subs = this.data.pushSubscriptions[vehicle];
    if (!subs || subs.length === 0) return;
    const body = JSON.stringify(payload);
    const stillValid = [];
    const sends = subs.map((sub) =>
      webpush.sendNotification(sub, body)
        .then(() => { stillValid.push(sub); })
        .catch((err) => {
          if (err.statusCode !== 410 && err.statusCode !== 404) stillValid.push(sub);
        })
    );
    Promise.all(sends).then(async () => {
      this.data.pushSubscriptions[vehicle] = stillValid;
      await this.save();
    });
  }

  notifyVehicle(vehicle, incident) {
    const v = this.data.vehicleStates[vehicle];
    if (!v) return;
    const alreadyTasked = v.incomingQueue.some((i) => i.id === incident.id) || v.queue.some((i) => i.id === incident.id);
    if (alreadyTasked) return;
    const tagged = { ...incident, taskedTo: vehicle, status: "Tasked" };
    v.incomingQueue.push(tagged);
    this.data.unassignedIncidents = this.data.unassignedIncidents.filter((i) => i.id !== incident.id);
    this.data.allIncidents = this.data.allIncidents.map((i) => (i.id === incident.id ? { ...i, taskedTo: vehicle, status: "Tasked" } : i));
    this.addIncidentTimelineEntry(incident.id, "Tasked", `Tasked to ${vehicle}`);
    this.logEventFor(vehicle, `${vehicle} Tasked on incident ${this.shortId(incident.id)} (pending acknowledgement)`);
    this.sendPushToVehicle(vehicle, {
      title: `${vehicle} — Incoming Tasking`,
      body: `${incident.type || "Incident"} — ${incident.addr || ""}`,
      icon: "/icon-192.png",
    });
  }

  addToPool(incident) {
    this.data.unassignedIncidents.unshift(incident);
  }

  // Returns the id of a job currently EN ROUTE or ONSITE for this
  // vehicle, if any -- that job is locked in as primary and blocks any
  // other job from taking over primary status.
  getLockedJobId(v) {
    for (const jobId in v.progress) {
      const phase = v.progress[jobId]?.phase;
      if (phase === "EN ROUTE" || phase === "ONSITE") return jobId;
    }
    return null;
  }

  // ---------------------------------------------------------------
  // ACTIONS -- one handler per action type, same behaviour as
  // bkk_server.js's `actions` object, ported to methods so they can
  // reach `this.data` and the helpers above.
  // ---------------------------------------------------------------
  getActionHandler(type) {
    const self = this;
    const actions = {
      CREATE_INCIDENT(payload) {
        const { fields, vehicles } = payload;
        const incident = {
          id: `Incident 0000-${pad4(self.data.incidentCounter)}`,
          dist: (fields && fields.dist) || null,
          eta: (fields && fields.eta) || null,
          taskedAt: new Date().toISOString(),
          status: "New",
          photos: [],
          ...fields,
        };
        self.data.incidentCounter += 1;
        self.data.allIncidents.unshift(incident);
        self.addIncidentTimelineEntry(incident.id, "New", "Incident created", incident.taskedAt);

        const chosen = Array.isArray(vehicles) ? vehicles.filter((v) => VEHICLES.includes(v)) : [];
        if (chosen.length > 0) {
          chosen.forEach((v) => self.notifyVehicle(v, incident));
        } else {
          self.addToPool(incident);
        }
        return { incident: self.data.allIncidents.find((i) => i.id === incident.id) };
      },

      // Photos are stored as separate Durable Object storage keys, not
      // inline in the incident record -- otherwise every /state fetch
      // (polled constantly by every open app) would balloon in size as
      // photos get added. Only lightweight metadata lives on the
      // incident itself; the actual image bytes are fetched on demand
      // via GET /photo/{id}.
      UPLOAD_PHOTO(payload) {
        const { incidentId, filename, mimeType, dataBase64 } = payload;
        const incident = self.data.allIncidents.find((i) => i.id === incidentId);
        if (!incident) throw new Error("Unknown incident");
        if (!dataBase64) throw new Error("No image data provided");
        // Rough safety cap -- base64 is ~4/3 the size of the raw bytes,
        // so this keeps actual images under roughly 6MB.
        if (dataBase64.length > 8_000_000) throw new Error("Photo is too large");

        const photoId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        self.photoWrites = self.photoWrites || [];
        self.photoWrites.push(
          self.ctrl.storage.put(`photo:${photoId}`, { mimeType: mimeType || "image/jpeg", dataBase64 })
        );

        const meta = { id: photoId, filename: filename || "photo.jpg", mimeType: mimeType || "image/jpeg", uploadedAt: new Date().toISOString() };
        self.updateIncidentEverywhere(incidentId, (i) => ({ ...i, photos: [...(i.photos || []), meta] }));

        if (!self.data.incidentNotes[incidentId]) self.data.incidentNotes[incidentId] = [];
        self.data.incidentNotes[incidentId].unshift({
          id: `${Date.now()}-${Math.random()}`,
          text: "A new photo has been uploaded.",
          tags: ["Information"],
          subject: "Photo Upload",
          time: meta.uploadedAt,
          actionRequired: false, resolved: false, resolvedAt: null, resolutionText: null,
        });

        return { photo: meta };
      },

      DELETE_PHOTO(payload) {
        const { incidentId, photoId } = payload;
        const incident = self.data.allIncidents.find((i) => i.id === incidentId);
        if (!incident) throw new Error("Unknown incident");
        self.updateIncidentEverywhere(incidentId, (i) => ({ ...i, photos: (i.photos || []).filter((p) => p.id !== photoId) }));
        self.photoWrites = self.photoWrites || [];
        self.photoWrites.push(self.ctrl.storage.delete(`photo:${photoId}`));
        return {};
      },

      NOTIFY_VEHICLE(payload) {
        const { vehicle, incidentId } = payload;
        const incident = self.data.allIncidents.find((i) => i.id === incidentId);
        if (!incident || !VEHICLES.includes(vehicle)) throw new Error("Unknown incident or vehicle");
        self.notifyVehicle(vehicle, incident);
        return {};
      },

      ACKNOWLEDGE_INCIDENT(payload) {
        const { incidentId, availableForRescue } = payload;
        self.updateIncidentEverywhere(incidentId, (i) => ({ ...i, availableForRescue: availableForRescue ?? i.availableForRescue ?? null }));
        self.setIncidentStatus(incidentId, "Active", availableForRescue != null ? `Available for Rescue: ${availableForRescue ? "Yes" : "No"}` : null);
        return {};
      },

      REJECT_INCIDENT(payload) {
        const { incidentId, reason, timestamp, note } = payload;
        if (!REJECT_REASONS.includes(reason)) throw new Error("Unknown reject reason");
        const finalNote = reason === "Other" ? (note || "").trim() || "Other" : reason;
        self.setIncidentStatus(incidentId, "Rejected", finalNote, timestamp);
        return {};
      },

      RECCE_INCIDENT(payload) {
        const { incidentId } = payload;
        self.updateIncidentEverywhere(incidentId, (i) => ({ ...i, reconnoitered: true }));
        self.addIncidentTimelineEntry(incidentId, "Recce'd", "Reconnoitered");
        return {};
      },

      COMPLETE_INCIDENT(payload) {
        const { incidentId, note, timestamp } = payload;
        self.setIncidentStatus(incidentId, "Complete", note || null, timestamp);
        return {};
      },

      CANCEL_INCIDENT(payload) {
        const { incidentId, reason, timestamp, note } = payload;
        if (!CANCEL_REASONS.includes(reason)) throw new Error("Unknown cancel reason");
        const finalNote = reason === "Other" ? (note || "").trim() || "Other" : reason;
        self.setIncidentStatus(incidentId, "Cancelled", finalNote, timestamp);
        return {};
      },

      REOPEN_INCIDENT(payload) {
        const { incidentId } = payload;
        self.setIncidentStatus(incidentId, "Active", "Reopened");
        return {};
      },

      FINALISE_INCIDENT(payload) {
        const { incidentId, note, timestamp } = payload;
        self.setIncidentStatus(incidentId, "Finalised", note || null, timestamp);
        return {};
      },

      SUBSCRIBE_PUSH(payload) {
        const { vehicle, subscription } = payload;
        if (!VEHICLES.includes(vehicle)) throw new Error("Unknown vehicle");
        if (!subscription || !subscription.endpoint) throw new Error("Invalid push subscription");
        if (!self.data.pushSubscriptions[vehicle]) self.data.pushSubscriptions[vehicle] = [];
        self.data.pushSubscriptions[vehicle] = self.data.pushSubscriptions[vehicle].filter((s) => s.endpoint !== subscription.endpoint);
        self.data.pushSubscriptions[vehicle].push(subscription);
        return {};
      },

      UNSUBSCRIBE_PUSH(payload) {
        const { vehicle, endpoint } = payload;
        if (!self.data.pushSubscriptions[vehicle]) return {};
        self.data.pushSubscriptions[vehicle] = self.data.pushSubscriptions[vehicle].filter((s) => s.endpoint !== endpoint);
        return {};
      },

      ACKNOWLEDGE_INCOMING(payload) {
        const { vehicle } = payload;
        const v = self.data.vehicleStates[vehicle];
        if (!v) throw new Error("Unknown vehicle");
        const job = v.incomingQueue[0];
        if (!job) return {};
        const wasEmpty = v.queue.length === 0;
        v.incomingQueue = v.incomingQueue.slice(1);
        v.queue = [job, ...v.queue];
        if (wasEmpty) v.activeJob = job;
        self.logEventFor(vehicle, `${vehicle} Tasked on incident ${self.shortId(job.id)}`);
        return {};
      },

      DISMISS_INCOMING(payload) {
        const { vehicle } = payload;
        const v = self.data.vehicleStates[vehicle];
        if (!v) throw new Error("Unknown vehicle");
        const job = v.incomingQueue[0];
        if (!job) return {};
        v.incomingQueue = v.incomingQueue.slice(1);
        self.addToPool(job);
        self.logEventFor(vehicle, `${vehicle} dismissed incident ${self.shortId(job.id)}`);
        return {};
      },

      SET_ACTIVE_JOB(payload) {
        const { vehicle, jobId } = payload;
        const v = self.data.vehicleStates[vehicle];
        if (!v) throw new Error("Unknown vehicle");
        const lockedId = self.getLockedJobId(v);
        if (lockedId && lockedId !== jobId) {
          throw new Error(`Cannot change primary job -- incident ${self.shortId(lockedId)} is currently EN ROUTE/ONSITE`);
        }
        v.activeJob = v.queue.find((j) => j.id === jobId) || null;
        return {};
      },

      SET_PHASE(payload) {
        const { vehicle, jobId, phase } = payload;
        const v = self.data.vehicleStates[vehicle];
        if (!v) throw new Error("Unknown vehicle");
        if (phase === "EN ROUTE" || phase === "ONSITE") {
          const lockedId = self.getLockedJobId(v);
          if (lockedId && lockedId !== jobId) {
            throw new Error(`Cannot set this incident EN ROUTE/ONSITE -- incident ${self.shortId(lockedId)} already is`);
          }
        }
        const existing = v.progress[jobId] || { phase: null, times: {} };
        v.progress[jobId] = { phase, times: { ...existing.times, [phase]: new Date().toISOString() } };
        if (phase === "EN ROUTE" || phase === "ONSITE") {
          const job = v.queue.find((j) => j.id === jobId);
          if (job) v.activeJob = job;
        }
        self.logEventFor(vehicle, `${vehicle} ${phase} on incident ${self.shortId(jobId)}`);
        return {};
      },

      COMPLETE_JOB(payload) {
        const { vehicle, jobId, mode, formData } = payload;
        const v = self.data.vehicleStates[vehicle];
        if (!v) throw new Error("Unknown vehicle");
        const job = v.queue.find((j) => j.id === jobId);
        if (!job) throw new Error("Job not found on this vehicle's queue");
        v.queue = v.queue.filter((j) => j.id !== jobId);
        v.activeJob = v.queue.length === 1 ? v.queue[0] : null;
        delete v.progress[jobId];
        const onBoard = v.crew.filter((c) => c.on).map((c) => `${c.first} ${c.last}`);
        self.data.completedJobs.unshift({ job, mode, formData, vehicle, onBoard });
        self.logEventFor(vehicle, `${vehicle} Complete on incident ${self.shortId(jobId)}`);
        self.addIncidentTimelineEntry(jobId, "Team Completion Notes", `${vehicle} — ${(formData && formData.note) || "Completed, no note"}`);
        return {};
      },

      CALL_OFF_JOB(payload) {
        const { vehicle, jobId, reason } = payload;
        const v = self.data.vehicleStates[vehicle];
        if (!v) throw new Error("Unknown vehicle");
        const job = v.queue.find((j) => j.id === jobId);
        if (!job) throw new Error("Job not found on this vehicle's queue");
        v.queue = v.queue.filter((j) => j.id !== jobId);
        v.activeJob = v.queue.length === 1 ? v.queue[0] : null;
        delete v.progress[jobId];
        const onBoard = v.crew.filter((c) => c.on).map((c) => `${c.first} ${c.last}`);
        self.data.calledOffJobs.unshift({ job, reason, vehicle, onBoard });
        self.logEventFor(vehicle, `${vehicle} Called Off incident ${self.shortId(jobId)} — ${reason}`);
        return {};
      },

      SET_TEAM_STATUS(payload) {
        const { vehicle, statusId } = payload;
        const v = self.data.vehicleStates[vehicle];
        const status = STATUS_BY_ID[statusId];
        if (!v || !status) throw new Error("Unknown vehicle or status");
        v.teamStatus = status;
        self.logEventFor(vehicle, `Team set as ${status.label}`);
        if (v.activeJob) self.addIncidentTimelineEntry(v.activeJob.id, "Team Status", `${vehicle} set as ${status.label}`);
        return {};
      },

      ADD_CREW_MEMBER(payload) {
        const { vehicle, ssMemberId } = payload;
        const v = self.data.vehicleStates[vehicle];
        const member = self.data.ssMembers.find((m) => m.id === ssMemberId);
        if (!v || !member) throw new Error("Unknown vehicle or SES member");
        if (v.crew.some((c) => c.id === member.id)) return {};
        const newMember = {
          id: member.id, first: member.firstName, last: member.lastName,
          phone: member.number400, on: true, capabilities: member.capabilities || [],
        };
        v.crew.push(newMember);
        self.logEventFor(vehicle, `${newMember.first} ${newMember.last} added to team`);
        return {};
      },

      REMOVE_CREW_MEMBER(payload) {
        const { vehicle, memberId } = payload;
        const v = self.data.vehicleStates[vehicle];
        if (!v) throw new Error("Unknown vehicle");
        const member = v.crew.find((c) => c.id === memberId);
        v.crew = v.crew.filter((c) => c.id !== memberId);
        if (v.leaderId === memberId) v.leaderId = null;
        if (member) self.logEventFor(vehicle, `${member.first} ${member.last} removed from team`);
        return {};
      },

      SET_LEADER(payload) {
        const { vehicle, memberId } = payload;
        const v = self.data.vehicleStates[vehicle];
        if (!v) throw new Error("Unknown vehicle");
        const member = v.crew.find((c) => c.id === memberId);
        v.leaderId = memberId;
        if (member) self.logEventFor(vehicle, `${member.first} ${member.last} added to team as team leader`);
        return {};
      },

      ADD_NOTE(payload) {
        const { incidentId, text, tags, subject, actionRequired } = payload;
        if (!text || !text.trim()) return {};
        if (!self.data.incidentNotes[incidentId]) self.data.incidentNotes[incidentId] = [];
        const note = {
          id: `${Date.now()}-${Math.random()}`,
          text: text.trim(),
          tags: Array.isArray(tags) ? tags : [],
          subject: subject || null,
          time: new Date().toISOString(),
          actionRequired: !!actionRequired,
          resolved: false,
          resolvedAt: null,
          resolutionText: null,
        };
        self.data.incidentNotes[incidentId].unshift(note);
        return { note };
      },

      RESOLVE_NOTE(payload) {
        const { incidentId, noteId, resolutionText, stillActionRequired } = payload;
        const notes = self.data.incidentNotes[incidentId];
        if (!notes) throw new Error("No notes for this incident");
        const note = notes.find((n) => n.id === noteId);
        if (!note) throw new Error("Note not found");
        note.resolutionText = (resolutionText || "").trim() || null;
        note.resolvedAt = new Date().toISOString();
        note.actionRequired = !!stillActionRequired;
        note.resolved = !stillActionRequired;
        return { note };
      },

      CREATE_SES_MEMBER(payload) {
        const member = { id: `ses-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...payload };
        self.data.ssMembers.unshift(member);
        return { member };
      },

      CREATE_EXTERNAL_PERSON(payload) {
        const person = { id: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, createdAt: "Bankstown", ...payload };
        self.data.externalPeople.unshift(person);
        return { person };
      },

      SET_SUBURB_ASSIGNMENT(payload) {
        const { suburb, vehicle } = payload;
        if (!SUBURBS.includes(suburb)) throw new Error("Unknown suburb");
        if (vehicle) {
          if (!VEHICLES.includes(vehicle)) throw new Error("Unknown vehicle");
          self.data.suburbAssignments[suburb] = vehicle;
        } else {
          delete self.data.suburbAssignments[suburb];
        }
        return {};
      },

      SET_AUTO_REQUEST(payload) {
        self.data.autoRequestNearestAsset = !!payload.value;
        return {};
      },
    };
    return actions[type];
  }

  // ---------------------------------------------------------------
  // HTTP HANDLING -- Workers Request/Response instead of Node's
  // http req/res, same routes and behaviour as bkk_server.js.
  // ---------------------------------------------------------------
  async fetch(request) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, ngrok-skip-browser-warning",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, time: new Date().toISOString() }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      return new Response(JSON.stringify(this.data), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const photoMatch = request.method === "GET" && url.pathname.match(/^\/photo\/([\w-]+)$/);
    if (photoMatch) {
      const stored = await this.ctrl.storage.get(`photo:${photoMatch[1]}`);
      if (!stored) {
        return new Response(JSON.stringify({ error: "Photo not found" }), {
          status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const bytes = Uint8Array.from(atob(stored.dataBase64), (c) => c.charCodeAt(0));
      return new Response(bytes, {
        headers: {
          "Content-Type": stored.mimeType || "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable",
          ...corsHeaders,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/action") {
      try {
        const body = await request.json();
        const handler = this.getActionHandler(body.type);
        if (!handler) {
          return new Response(JSON.stringify({ error: `Unknown action type: ${body.type}` }), {
            status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        this.photoWrites = [];
        const result = handler(body.payload || {});
        if (this.photoWrites.length > 0) await Promise.all(this.photoWrites);
        await this.save();
        return new Response(JSON.stringify({ ok: true, result, state: this.data }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}

// ---------------------------------------------------------------
// MAIN WORKER -- every request goes to the same single Durable
// Object instance ("singleton"), which is what makes all apps share
// one consistent view of the data, same as the old single-process
// Node server did.
// ---------------------------------------------------------------
export default {
  async fetch(request, env) {
    const id = env.BKK_STATE.idFromName("singleton");
    const stub = env.BKK_STATE.get(id);
    return stub.fetch(request);
  },
};