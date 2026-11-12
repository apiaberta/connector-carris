import mongoose from 'mongoose'
import { VEHICLES_MONGO_TTL_SECONDS } from '../config.js'

const vehicleSchema = new mongoose.Schema({
    id:                { type: String, required: true },
    line_id:           String,
    route_id:          String,
    pattern_id:        String,
    trip_id:           String,
    stop_id:           String,
    lat:               Number,
    lon:               Number,
    bearing:           Number,
    current_status:    String,
    occupancy_status:  String,
    door_status:       String,
    timestamp:         Date,
    seen_at:           { type: Date, default: Date.now }
}, { collection: 'vehicles' })

// Unique upsert key for bulkWrite of live positions (v1.0.0).
vehicleSchema.index({ id: 1 }, { unique: true })
// Fallback GET /carris/vehicles?line_id= when the in-memory snapshot is empty.
vehicleSchema.index({ line_id: 1 })
// Fallback GET /carris/vehicles?route_id= (added v1.1.0). Small collection;
// mongoose autoIndex builds this on startup. See README "Mongo indexes".
vehicleSchema.index({ route_id: 1 })
// Drop positions not rewritten for 1h. Mongo TTL monitor (~60s granularity).
// Changing expireAfterSeconds does NOT update an existing index — drop
// vehicles.seen_at_1 on the mongod first, then restart the connector.
vehicleSchema.index({ seen_at: 1 }, { expireAfterSeconds: VEHICLES_MONGO_TTL_SECONDS })

export const Vehicle = mongoose.model('Vehicle', vehicleSchema)
