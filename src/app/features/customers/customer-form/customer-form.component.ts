import { Component, inject, OnInit, signal, computed, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute, RouterModule } from '@angular/router';
import { Firestore, doc, getDoc } from '@angular/fire/firestore';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { Customer, Branch, CenterOrSamity } from '../../../core/models/database.models';

@Component({
  selector: 'app-customer-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './customer-form.component.html',
  styleUrl: './customer-form.component.scss'
})
export class CustomerFormComponent implements OnInit {
  private firestore = inject(Firestore);
  private kistiService = inject(KistiDatabaseService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);
  readonly staffList = this.authService.availableUsers;

  isEditMode = signal<boolean>(false);
  customerId = signal<number | null>(null);
  loading = signal<boolean>(false);
  submitting = signal<boolean>(false);

  // Mandatory reason when in edit mode
  updateReason: string = '';

  @Input() set customerToEdit(cust: Customer | null) {
    if (cust) {
      this.patchCustomerData(cust);
    } else if (!this.customerId()) {
      this.resetForm();
    }
  }

  @Output() formSubmitted = new EventEmitter<Customer>();
  @Output() formCancelled = new EventEmitter<void>();

  // Form Model
  customer: any = this.getDefaultCustomer();

  readonly selectedBranchId = signal<number>(1);

  readonly availableCenters = computed(() => {
    const bId = Number(this.selectedBranchId());
    return this.centers().filter(c => c.branchId === bId);
  });

  getDefaultCustomer(): any {
    return {
      branchId: 1,
      centerId: 101,
      assignedFieldOfficerId: 502,
      fullName: '',
      fatherName: '',
      motherName: '',
      spouseName: '',
      dateOfBirth: '1995-01-01',
      gender: 'FEMALE' as 'MALE' | 'FEMALE' | 'OTHER',
      phonePrimary: '',
      phoneSecondary: '',
      nidNumber: '',
      birthCertificateNo: '',
      presentAddress: {
        villageOrStreet: '',
        postOffice: '',
        thanaOrUpazila: 'মিরপুর',
        district: 'ঢাকা',
        houseOwnership: 'RENTED' as 'OWN' | 'RENTED' | 'FAMILY'
      },
      permanentAddress: {
        villageOrStreet: '',
        postOffice: '',
        thanaOrUpazila: '',
        district: ''
      },
      occupation: 'মুদি ব্যবসা',
      businessName: '',
      monthlyIncome: 25000,
      primaryGuarantor: {
        name: '',
        relation: 'স্বামী',
        phone: '',
        nidNumber: '',
        address: '',
        occupation: 'চালক'
      },
      secondaryGuarantor: {
        name: '',
        relation: 'প্রতিবেশী',
        phone: '',
        nidNumber: '',
        address: '',
        occupation: 'ব্যবসায়ী'
      },
      collateral: {
        hasBankCheque: true,
        bankName: 'ইসলামী ব্যাংক বাংলাদেশ পিএলসি',
        bankBranch: 'মিরপুর শাখা',
        accountNumber: '',
        chequeNumber: '',
        hasStamp: true,
        stampNumber: '',
        otherMortgageDetails: ''
      },
      totalSavingsBalance: 0,
      totalLoansTaken: 0,
      activeLoansCount: 0,
      creditScore: 'GOOD' as const
    };
  }

  async ngOnInit() {
    await this.loadOrganizationData();
    const idParam = this.route.snapshot.paramMap.get('id');
    if (idParam) {
      const parsedId = Number(idParam);
      this.isEditMode.set(true);
      this.customerId.set(parsedId);
      await this.loadCustomerForEdit(parsedId);
    }
  }

  async loadOrganizationData() {
    try {
      const [bList, cList] = await Promise.all([
        this.kistiService.getBranches(),
        this.kistiService.getCenters()
      ]);
      this.branches.set(bList);
      this.centers.set(cList);

      if (bList.length > 0 && !this.isEditMode()) {
        const initialBranchId = bList[0].branchId;
        this.selectedBranchId.set(initialBranchId);
        this.customer.branchId = initialBranchId;

        const routesInBranch = cList.filter(c => c.branchId === initialBranchId);
        if (routesInBranch.length > 0) {
          this.customer.centerId = routesInBranch[0].centerId;
          this.customer.assignedFieldOfficerId = routesInBranch[0].fieldOfficerUserId;
        }
      }
    } catch (e) {
      console.error('Error loading branch/center data:', e);
    }
  }

  resetForm() {
    this.isEditMode.set(false);
    this.customerId.set(null);
    this.updateReason = '';
    this.customer = this.getDefaultCustomer();
    if (this.branches().length > 0) {
      const bId = this.branches()[0].branchId;
      this.selectedBranchId.set(bId);
      this.customer.branchId = bId;
      const routesInBranch = this.centers().filter(c => c.branchId === bId);
      if (routesInBranch.length > 0) {
        this.customer.centerId = routesInBranch[0].centerId;
        this.customer.assignedFieldOfficerId = routesInBranch[0].fieldOfficerUserId;
      }
    }
  }

  patchCustomerData(cust: Customer) {
    this.isEditMode.set(true);
    this.customerId.set(cust.customerId);
    this.updateReason = '';
    const bId = Number(cust.branchId || 1);
    this.selectedBranchId.set(bId);

    this.customer = {
      customerId: cust.customerId,
      customerCode: cust.customerCode || `CUST-${cust.customerId}`,
      branchId: bId,
      centerId: Number(cust.centerId || 101),
      assignedFieldOfficerId: Number(cust.assignedFieldOfficerId || 502),
      fullName: cust.fullName || '',
      fatherName: cust.fatherName || '',
      motherName: cust.motherName || '',
      spouseName: cust.spouseName || '',
      dateOfBirth: cust.dateOfBirth ? cust.dateOfBirth.substring(0, 10) : '1995-01-01',
      gender: cust.gender || 'FEMALE',
      phonePrimary: cust.phonePrimary || '',
      phoneSecondary: cust.phoneSecondary || '',
      nidNumber: cust.nidNumber || '',
      birthCertificateNo: cust.birthCertificateNo || '',
      presentAddress: {
        villageOrStreet: cust.presentAddress?.villageOrStreet || '',
        postOffice: cust.presentAddress?.postOffice || '',
        thanaOrUpazila: cust.presentAddress?.thanaOrUpazila || '',
        district: cust.presentAddress?.district || 'ঢাকা',
        houseOwnership: cust.presentAddress?.houseOwnership || 'OWN'
      },
      permanentAddress: {
        villageOrStreet: cust.permanentAddress?.villageOrStreet || '',
        postOffice: cust.permanentAddress?.postOffice || '',
        thanaOrUpazila: cust.permanentAddress?.thanaOrUpazila || '',
        district: cust.permanentAddress?.district || ''
      },
      occupation: cust.occupation || '',
      businessName: cust.businessName || '',
      monthlyIncome: cust.monthlyIncome || 0,
      primaryGuarantor: {
        name: cust.primaryGuarantor?.name || '',
        relation: cust.primaryGuarantor?.relation || '',
        phone: cust.primaryGuarantor?.phone || '',
        nidNumber: cust.primaryGuarantor?.nidNumber || '',
        address: cust.primaryGuarantor?.address || '',
        occupation: cust.primaryGuarantor?.occupation || ''
      },
      secondaryGuarantor: {
        name: cust.secondaryGuarantor?.name || '',
        relation: cust.secondaryGuarantor?.relation || '',
        phone: cust.secondaryGuarantor?.phone || '',
        nidNumber: cust.secondaryGuarantor?.nidNumber || '',
        address: cust.secondaryGuarantor?.address || '',
        occupation: cust.secondaryGuarantor?.occupation || ''
      },
      collateral: {
        hasBankCheque: cust.collateral?.hasBankCheque ?? true,
        bankName: cust.collateral?.bankName || '',
        bankBranch: cust.collateral?.bankBranch || '',
        accountNumber: cust.collateral?.accountNumber || '',
        chequeNumber: cust.collateral?.chequeNumber || '',
        hasStamp: cust.collateral?.hasStamp ?? true,
        stampNumber: cust.collateral?.stampNumber || '',
        otherMortgageDetails: cust.collateral?.otherMortgageDetails || ''
      },
      totalSavingsBalance: cust.totalSavingsBalance || 0,
      totalLoansTaken: cust.totalLoansTaken || 0,
      activeLoansCount: cust.activeLoansCount || 0,
      creditScore: cust.creditScore || 'GOOD',
      status: cust.status || 'ACTIVE'
    };
  }

  onBranchChange(branchId: any) {
    const bId = Number(branchId);
    this.selectedBranchId.set(bId);
    this.customer.branchId = bId;

    const routesInBranch = this.centers().filter(c => c.branchId === bId);
    if (routesInBranch.length > 0) {
      if (!routesInBranch.some(c => c.centerId === this.customer.centerId)) {
        this.customer.centerId = routesInBranch[0].centerId;
        this.customer.assignedFieldOfficerId = routesInBranch[0].fieldOfficerUserId;
      }
    } else {
      this.customer.centerId = null;
    }
  }

  onCenterChange(centerId: any) {
    const cid = Number(centerId);
    this.customer.centerId = cid;
    const center = this.centers().find(c => c.centerId === cid);
    if (center) {
      this.customer.assignedFieldOfficerId = center.fieldOfficerUserId;
    }
  }

  async loadCustomerForEdit(id: number) {
    this.loading.set(true);
    try {
      // 1. First search in kistiService getCustomers (handles cache and seeding)
      const allCustomers = await this.kistiService.getCustomers();
      let match = allCustomers.find(c => c.customerId === id);

      // 2. If not found in list, try direct getDoc from Firestore
      if (!match) {
        const docRef = doc(this.firestore, 'customers', id.toString());
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          match = snap.data() as Customer;
        }
      }

      if (match) {
        this.patchCustomerData(match);
      } else {
        alert('গ্রাহক আইডি #' + id + ' পাওয়া যায়নি');
        this.router.navigate(['/customers']);
      }
    } catch (err) {
      console.error('Error loading customer:', err);
      // Fallback: try kistiService.getCustomers again
      try {
        const allCustomers = await this.kistiService.getCustomers();
        const match = allCustomers.find(c => c.customerId === id);
        if (match) {
          this.patchCustomerData(match);
        }
      } catch (e) {
        console.error('Fallback error:', e);
      }
    } finally {
      this.loading.set(false);
    }
  }

  async onSubmit() {
    if (!this.customer.fullName?.trim() || !this.customer.phonePrimary?.trim() || !this.customer.nidNumber?.trim()) {
      alert('অনুগ্রহ করে নাম, প্রাথমিক মোবাইল নম্বর এবং NID অবশ্যই প্রদান করুন');
      return;
    }

    if (this.isEditMode() && !this.updateReason.trim()) {
      alert('সংশোধন নিশ্চিত করতে পরিবর্তনের কারণ (Reason for Change) উল্লেখ করুন');
      return;
    }

    this.submitting.set(true);
    const currentUser = this.authService.currentUser();

    try {
      if (this.isEditMode()) {
        await this.kistiService.updateCustomer(
          this.customerId()!,
          this.customer,
          { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
          this.updateReason
        );
        alert(`গ্রাহক #${this.customerId()} এর তথ্য সফলভাবে আপডেট ও হিস্ট্রি সংরক্ষণ করা হয়েছে`);
      } else {
        const newCust = await this.kistiService.createCustomer(
          this.customer,
          { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
          'নতুন সদস্য হিসেবে অন্তর্ভুক্ত'
        );
        alert(`সফল! নতুন গ্রাহক আইডি #${newCust.customerId} তৈরি হয়েছে`);
      }

      this.formSubmitted.emit(this.customer);
      this.router.navigate(['/customers']);
    } catch (err) {
      console.error('Save error:', err);
      alert('সংরক্ষণে সমস্যা হয়েছে');
    } finally {
      this.submitting.set(false);
    }
  }

  cancel() {
    this.resetForm();
    this.formCancelled.emit();
    this.router.navigate(['/customers']);
  }
}
