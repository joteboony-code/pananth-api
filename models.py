from flask_sqlalchemy import SQLAlchemy
from datetime import datetime

db = SQLAlchemy()


class Room(db.Model):
    __tablename__ = "rooms"

    id = db.Column(db.Integer, primary_key=True)
    number = db.Column(db.String(20), nullable=False, unique=True)
    floor = db.Column(db.Integer, nullable=True)
    monthly_rent = db.Column(db.Float, nullable=False)
    status = db.Column(db.String(20), default="vacant")  # occupied / vacant
    description = db.Column(db.String(255), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    tenants = db.relationship("Tenant", back_populates="room", lazy=True)

    def __repr__(self):
        return f"<Room {self.number}>"


class Tenant(db.Model):
    __tablename__ = "tenants"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    phone = db.Column(db.String(20), nullable=True)
    line_user_id = db.Column(db.String(100), nullable=True)  # LINE User ID (Uxxxxxxxx)
    move_in_date = db.Column(db.Date, nullable=True)
    move_out_date = db.Column(db.Date, nullable=True)
    is_active = db.Column(db.Boolean, default=True)
    room_id = db.Column(db.Integer, db.ForeignKey("rooms.id"), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    room = db.relationship("Room", back_populates="tenants")
    payments = db.relationship("Payment", back_populates="tenant", lazy=True)

    def __repr__(self):
        return f"<Tenant {self.name}>"


class Payment(db.Model):
    __tablename__ = "payments"

    id = db.Column(db.Integer, primary_key=True)
    tenant_id = db.Column(db.Integer, db.ForeignKey("tenants.id"), nullable=False)
    room_id = db.Column(db.Integer, db.ForeignKey("rooms.id"), nullable=False)
    year = db.Column(db.Integer, nullable=False)
    month = db.Column(db.Integer, nullable=False)  # 1-12
    amount = db.Column(db.Float, nullable=False)
    water_unit = db.Column(db.Float, default=0)
    water_rate = db.Column(db.Float, default=18.0)  # baht per unit
    electric_unit = db.Column(db.Float, default=0)
    electric_rate = db.Column(db.Float, default=8.0)  # baht per unit
    status = db.Column(db.String(20), default="pending")  # pending / paid
    paid_at = db.Column(db.DateTime, nullable=True)
    note = db.Column(db.String(255), nullable=True)
    notified_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    tenant = db.relationship("Tenant", back_populates="payments")
    room = db.relationship("Room")

    @property
    def water_cost(self):
        return self.water_unit * self.water_rate

    @property
    def electric_cost(self):
        return self.electric_unit * self.electric_rate

    @property
    def total_amount(self):
        return self.amount + self.water_cost + self.electric_cost

    @property
    def month_name_th(self):
        months_th = [
            "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน",
            "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม",
            "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
        ]
        return months_th[self.month]

    def __repr__(self):
        return f"<Payment {self.tenant_id} {self.year}/{self.month}>"
